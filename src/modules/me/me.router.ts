/// <reference path="../../types/express.d.ts" />
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { customersService } from '../customers/customers.service';
import { depositAddressService } from '../customers/deposit-address.service';
import { withdrawalsService } from '../withdrawals/withdrawals.service';

export const meRouter = Router();

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const withdrawalSchema = z.object({
  toAddress: z.string().min(1),
  amountSats: z.string().regex(/^\d+$/, 'amountSats must be a positive integer string'),
  idempotencyKey: z.string().optional(),
});

function ctx(req: Request): { tenantId: string; customerId: string } {
  return {
    tenantId: (req as any).tenantId as string,
    customerId: (req as any).customerId as string,
  };
}

// GET /v1/me
meRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const customer = customersService.getById(tenantId, customerId);
    res.json({ data: customer });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/balances
meRouter.get('/balances', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const balances = customersService.getBalances(tenantId, customerId);
    res.json({ data: balances });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/deposits
meRouter.get('/deposits', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const query = listQuerySchema.parse(req.query);
    const result = customersService.getDeposits(tenantId, customerId, query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/addresses
meRouter.get('/addresses', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const query = listQuerySchema.parse(req.query);
    const result = customersService.getAddresses(tenantId, customerId, query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/me/deposit-address
meRouter.post('/deposit-address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const result = await depositAddressService.generateForCustomer(tenantId, customerId);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// POST /v1/me/withdrawals
meRouter.post('/withdrawals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const body = withdrawalSchema.parse(req.body);
    const withdrawal = await withdrawalsService.create(tenantId, customerId, {
      toAddress: body.toAddress,
      amountSats: body.amountSats,
      idempotencyKey: body.idempotencyKey,
    });
    res.status(201).json({ data: withdrawal });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/withdrawals
meRouter.get('/withdrawals', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const query = listQuerySchema.parse(req.query);
    const result = withdrawalsService.list(tenantId, customerId, query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/withdrawals/:withdrawalId
meRouter.get('/withdrawals/:withdrawalId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = ctx(req);
    const withdrawal = withdrawalsService.getById(tenantId, req.params['withdrawalId']!);
    res.json({ data: withdrawal });
  } catch (err) {
    next(err);
  }
});
