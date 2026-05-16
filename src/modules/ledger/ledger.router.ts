import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ledgerService } from './ledger.service';
import { idempotencyService } from '../idempotency/idempotency.service';
import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import { satoshiToBtc } from '../../shared/money/index';

export const ledgerRouter = Router();

const createAccountSchema = z.object({
  walletId: z.string().optional(),
  customerId: z.string().optional(),
  chainId: z.string().min(1),
  assetId: z.string().min(1),
  name: z.string().min(1).max(200),
  metadata: z.record(z.unknown()).optional(),
});

const listAccountsQuerySchema = z.object({
  walletId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const listEntriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const transferSchema = z.object({
  fromLedgerAccountId: z.string().min(1),
  toLedgerAccountId: z.string().min(1),
  assetId: z.string().min(1),
  amount: z.string().regex(/^\d+$/, 'Amount must be satoshi integer string'),
  reference: z.string().optional(),
});

// POST /v1/ledger/accounts
ledgerRouter.post('/accounts', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const body = createAccountSchema.parse(req.body);

    // Validate chain and asset exist
    const db = getDb();
    if (!db.prepare('SELECT id FROM chains WHERE id = ?').get(body.chainId)) {
      throw new NotFoundError('Chain', body.chainId);
    }
    if (!db.prepare('SELECT id FROM assets WHERE id = ?').get(body.assetId)) {
      throw new NotFoundError('Asset', body.assetId);
    }

    const account = ledgerService.createAccount(tenantId, body);
    res.status(201).json({ data: account });
  } catch (err) {
    next(err);
  }
});

// GET /v1/ledger/accounts
ledgerRouter.get('/accounts', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const query = listAccountsQuerySchema.parse(req.query);
    const result = ledgerService.listAccounts(tenantId, query);
    res.json({
      data: result.data,
      pagination: {
        limit: query.limit ?? 20,
        cursor: query.cursor ?? null,
        nextCursor: result.nextCursor,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/ledger/accounts/:ledgerAccountId
ledgerRouter.get('/accounts/:ledgerAccountId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const account = ledgerService.getAccountById(tenantId, req.params['ledgerAccountId']!);
    res.json({ data: account });
  } catch (err) {
    next(err);
  }
});

// GET /v1/ledger/accounts/:ledgerAccountId/balances
ledgerRouter.get('/accounts/:ledgerAccountId/balances', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const accountId = req.params['ledgerAccountId']!;
    ledgerService.getAccountById(tenantId, accountId); // validates exists and belongs to tenant
    const balance = ledgerService.getBalance(accountId);
    res.json({
      data: {
        ledgerAccountId: accountId,
        pending: balance.pending,
        pending_display: satoshiToBtc(balance.pending),
        settled: balance.settled,
        settled_display: satoshiToBtc(balance.settled),
        total: balance.total,
        total_display: satoshiToBtc(balance.total),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/ledger/accounts/:ledgerAccountId/entries
ledgerRouter.get('/accounts/:ledgerAccountId/entries', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const accountId = req.params['ledgerAccountId']!;
    ledgerService.getAccountById(tenantId, accountId); // validates exists and belongs to tenant
    const query = listEntriesQuerySchema.parse(req.query);
    const result = ledgerService.listEntries(accountId, query);
    res.json({
      data: result.data,
      pagination: {
        limit: query.limit ?? 20,
        cursor: query.cursor ?? null,
        nextCursor: result.nextCursor,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/ledger/transfers
ledgerRouter.post('/transfers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (idempotencyKey) {
      const existing = idempotencyService.get(tenantId, idempotencyKey, 'ledger_transfer');
      if (existing) {
        res.status(existing.statusCode).json(existing.result);
        return;
      }
    }

    const body = transferSchema.parse(req.body);

    // Validate both accounts belong to this tenant before transferring
    ledgerService.getAccountById(tenantId, body.fromLedgerAccountId);
    ledgerService.getAccountById(tenantId, body.toLedgerAccountId);

    const { debit, credit } = ledgerService.transfer({
      fromLedgerAccountId: body.fromLedgerAccountId,
      toLedgerAccountId: body.toLedgerAccountId,
      assetId: body.assetId,
      amountRaw: body.amount,
      reference: body.reference,
    });

    const result = { data: { debit, credit } };

    if (idempotencyKey) {
      idempotencyService.save(tenantId, idempotencyKey, 'ledger_transfer', result, 201);
    }

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
