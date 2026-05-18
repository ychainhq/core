import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sweepsService } from './sweeps.service';
import { adapterRegistry } from '../../chain-adapters/registry';
import { ledgerService } from '../ledger/ledger.service';
import { logger } from '../../shared/logging/index';
import { ValidationError } from '../../shared/errors/index';

export const sweepsRouter = Router();

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const submitSignedSchema = z.object({
  signedPsbt: z.string().min(1),
});

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

// GET /v1/sweeps
sweepsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = sweepsService.list(tenantId(req), query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/sweeps/:sweepId
sweepsRouter.get('/:sweepId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const sweep = sweepsService.getById(tenantId(req), req.params['sweepId']!);
    res.json({ data: sweep });
  } catch (err) {
    next(err);
  }
});

// POST /v1/sweeps/:sweepId/submit-signed
// Tenant calls this after signing the PSBT returned in the sweep.ready_for_signing webhook.
// Platform finalizes and broadcasts the transaction.
sweepsRouter.post('/:sweepId/submit-signed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = submitSignedSchema.parse(req.body);
    const sweep = sweepsService.getById(tenantId(req), req.params['sweepId']!);

    if (sweep.status !== 'pending_signature') {
      throw new ValidationError(`Sweep is in status '${sweep.status}', expected 'pending_signature'`);
    }

    // Finalize and broadcast via Bitcoin adapter
    const adapter = adapterRegistry.get('bitcoin');

    let txHash: string;
    try {
      const finalizedResult = await adapter.finalizePsbt(body.signedPsbt);
      if (!finalizedResult.complete) {
        throw new Error('PSBT is not fully signed — missing signatures');
      }
      txHash = await (adapter as any).sendRawTransaction(finalizedResult.hex);
    } catch (err: any) {
      sweepsService.updateStatus(sweep.id, 'failed', { error: String(err) });
      throw new ValidationError(`Failed to broadcast sweep: ${err.message ?? err}`);
    }

    const updated = sweepsService.updateStatus(sweep.id, 'broadcast', {
      signedPsbt: body.signedPsbt,
      txHash,
    });

    // Credit sweep_in_transit — funds are in flight from deposit addresses to hot wallet
    const sitAccount = ledgerService.findAccountByTenantAndType(tenantId(req), 'sweep_in_transit');
    if (sitAccount) {
      ledgerService.addEntry({
        ledgerAccountId: sitAccount.id,
        type: 'sweep_broadcast',
        amountRaw: sweep.amount_raw,
        referenceType: 'sweep',
        referenceId: sweep.id,
      });
    }

    logger.info('Sweep broadcast', { sweepId: sweep.id, txHash, tenantId: tenantId(req) });

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});
