import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { adapterRegistry } from '../../chain-adapters/registry';
import { transactionsService } from './transactions.service';
import { webhooksService } from '../webhooks/webhooks.service';
import { idempotencyService } from '../idempotency/idempotency.service';
import { ValidationError, UnprocessableEntityError } from '../../shared/errors/index';
import { validateRawTransaction } from '../../shared/validation/bitcoin';

export const transactionsRouter = Router({ mergeParams: true });

// GET /v1/chains/:chain/transactions/:txHash
transactionsRouter.get('/:txHash', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chain, txHash } = req.params as { chain: string; txHash: string };
    const adapter = adapterRegistry.get(chain);

    const [rawTx, localTx] = await Promise.all([
      adapter.getRawTransaction(txHash, true),
      Promise.resolve(transactionsService.getByTxHash(chain, txHash)),
    ]);

    res.json({
      data: {
        ...rawTx,
        local: localTx ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/chains/:chain/transactions/:txHash/status
transactionsRouter.get('/:txHash/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chain, txHash } = req.params as { chain: string; txHash: string };
    const adapter = adapterRegistry.get(chain);
    const status = await adapter.getTransactionStatus(txHash);

    const localTx = transactionsService.getByTxHash(chain, txHash);

    res.json({
      data: {
        ...status,
        localStatus: localTx?.status ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/chains/:chain/transactions/broadcast
transactionsRouter.post('/broadcast', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chain = req.params['chain']!;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    const tenantId = (req as any).tenantId as string;

    // Check idempotency
    if (idempotencyKey) {
      const existing = idempotencyService.get(tenantId, idempotencyKey, 'broadcast');
      if (existing) {
        res.status(existing.statusCode).json(existing.result);
        return;
      }
    }

    const schema = z.object({
      rawTransaction: z.string().min(1),
    });

    const body = schema.parse(req.body);
    const adapter = adapterRegistry.get(chain);

    if (chain === 'bitcoin' && !validateRawTransaction(body.rawTransaction)) {
      throw new ValidationError('Invalid raw transaction format');
    }

    // Decode transaction
    const decoded = await adapter.decodeRawTransaction(body.rawTransaction);

    // Test mempool accept before broadcasting
    const acceptResult = await adapter.testMempoolAccept(body.rawTransaction);
    if (!acceptResult.allowed) {
      throw new UnprocessableEntityError(
        `Transaction rejected by mempool: ${acceptResult.rejectReason}`,
        { rejectReason: acceptResult.rejectReason }
      );
    }

    // Broadcast
    const txHash = await adapter.sendRawTransaction(body.rawTransaction);

    // Save transaction record
    const tx = transactionsService.upsertByHash(chain, txHash, {
      raw_tx: body.rawTransaction,
      status: 'broadcasted',
      broadcast_at: new Date().toISOString(),
    });

    // Emit webhook
    webhooksService.queueEvent('transaction.broadcasted', {
      txHash,
      chain,
      status: 'broadcasted',
      txId: tx.id,
    }, chain);

    const result = {
      data: {
        txHash,
        txId: tx.id,
        status: 'broadcasted',
        vsize: acceptResult.vsize,
      },
    };

    // Save idempotency result
    if (idempotencyKey) {
      idempotencyService.save(tenantId, idempotencyKey, 'broadcast', result, 200);
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /v1/chains/:chain/transactions/validate
transactionsRouter.post('/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const chain = req.params['chain']!;
    const schema = z.object({ rawTransaction: z.string().min(1) });
    const body = schema.parse(req.body);
    const adapter = adapterRegistry.get(chain);

    const result = await adapter.testMempoolAccept(body.rawTransaction);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});
