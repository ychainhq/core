import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sweepsService } from './sweeps.service';
import { adapterRegistry } from '../../chain-adapters/registry';
import { ledgerService } from '../ledger/ledger.service';
import { logger } from '../../shared/logging/index';
import { ValidationError } from '../../shared/errors/index';
import { ticklerService } from '../../shared/tickler/tickler.service';
import { resolveActorLogin } from '../../shared/tickler/tickler.actor';
import { utxoLockService } from '../../shared/utxo-lock/utxo-lock.service';

export const sweepsRouter = Router();

const summaryQuerySchema = z.object({
  chainId: z.string().default('bitcoin'),
  assetId: z.string().default('bitcoin:BTC'),
});

const listQuerySchema = z.object({
  chainId: z.string().optional(),
  assetId: z.string().optional(),
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

// GET /v1/sweeps/summary?chainId=bitcoin&assetId=bitcoin:BTC
sweepsRouter.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = summaryQuerySchema.parse(req.query);
    const summary = await sweepsService.getSummary(tenantId(req), query.chainId, query.assetId);
    res.json({ data: summary });
  } catch (err) {
    next(err);
  }
});

// GET /v1/sweeps?chainId=&assetId=&status=&cursor=&limit=
sweepsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = await sweepsService.list(tenantId(req), query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/sweeps/:sweepId
sweepsRouter.get('/:sweepId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sweep = await sweepsService.getById(tenantId(req), req.params['sweepId']!);
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
    const sweep = await sweepsService.getById(tenantId(req), req.params['sweepId']!);

    if (sweep.status !== 'pending_signature') {
      throw new ValidationError(`Sweep is in status '${sweep.status}', expected 'pending_signature'`);
    }

    // Finalize and broadcast — chain-aware
    const adapter = adapterRegistry.get(sweep.chain_id);

    let txHash: string;
    try {
      if (sweep.chain_id === 'bitcoin') {
        const finalizedResult = await adapter.finalizePsbt(body.signedPsbt);
        if (!finalizedResult.complete) {
          throw new Error('PSBT is not fully signed — missing signatures');
        }
        txHash = await adapter.sendRawTransaction(finalizedResult.hex);
      } else {
        // TRON and future chains: signed payload is directly broadcastable
        txHash = await adapter.sendRawTransaction(body.signedPsbt);
      }
    } catch (err: any) {
      await sweepsService.updateStatus(sweep.id, 'failed', { error: String(err) });
      await utxoLockService.releaseLocksForSweep(tenantId(req), sweep.id).catch((e) =>
        logger.warn('Failed to release sweep UTXO locks after broadcast error', {
          sweepId: sweep.id, error: String(e),
        }),
      );
      throw new ValidationError(`Failed to broadcast sweep: ${err.message ?? err}`);
    }

    const updated = await sweepsService.updateStatus(sweep.id, 'broadcast', {
      signedPsbt: body.signedPsbt,
      txHash,
    });

    // Credit sweep_in_transit — funds are in flight from deposit addresses to hot wallet
    const sitAccount = await ledgerService.findAccountByTenantAndType(tenantId(req), 'sweep_in_transit');
    if (sitAccount) {
      await ledgerService.addEntry({
        ledgerAccountId: sitAccount.id,
        type: 'sweep_broadcast',
        amountRaw: sweep.amount_raw,
        referenceType: 'sweep',
        referenceId: sweep.id,
      });
    }

    ticklerService.record({
      tenantId: tenantId(req),
      category: 'sweep',
      subcategory: 'signed_submitted',
      entityId: sweep.id,
      actorLogin: resolveActorLogin(req),
      field1: txHash,
      field2: updated.status,
      newValue: updated,
    });

    logger.info('Sweep broadcast', { sweepId: sweep.id, txHash, tenantId: tenantId(req) });

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});
