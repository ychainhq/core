/**
 * Withdrawal Batches Router
 *
 * GET  /v1/withdrawal-batches
 * GET  /v1/withdrawal-batches/:batchId
 * POST /v1/withdrawal-batches/:batchId/approve
 * POST /v1/withdrawal-batches/:batchId/reject
 * POST /v1/withdrawal-batches/:batchId/retry
 * POST /v1/withdrawal-batches/:batchId/cancel
 * POST /v1/withdrawal-batches/:batchId/rbf-bump
 * POST /v1/withdrawal-batches/:batchId/cpfp
 *
 * GET   /v1/tenant/withdrawal-batch-config
 * PATCH /v1/tenant/withdrawal-batch-config
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { withdrawalBatcherService } from './withdrawal-batcher.service';
import { resolvePermission } from '../../shared/actor-auth/context';
import { ApiError } from '../../shared/errors/index';

export const withdrawalBatchesRouter = Router();
export const withdrawalBatchConfigRouter = Router();

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

function checkActorAccess(req: Request, entity: string, action: 'read' | 'write'): void {
  const ctx = (req as any).actorContext;
  if (!ctx) return; // No X-Actor-Token = admin mode, pass through
  const resolved = resolvePermission(ctx, entity, action);
  if (resolved.level === 'none') {
    throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', `Actor lacks ${entity}:${action} permission`);
  }
}

// GET /v1/withdrawal-batches
withdrawalBatchesRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    checkActorAccess(req, 'withdrawal-batch', 'read');
    const limit = parseInt((req.query['limit'] as string) || '20', 10);
    const cursor = req.query['cursor'] as string | undefined;
    const status = req.query['status'] as string | undefined;
    const chainId = req.query['chainId'] as string | undefined;

    const result = withdrawalBatcherService.listBatches(tenantId(req), { status, chainId, limit, cursor });
    res.json({
      data: result.data,
      pagination: { limit, cursor: cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) { next(err); }
});

// GET /v1/withdrawal-batches/:batchId
withdrawalBatchesRouter.get('/:batchId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = withdrawalBatcherService.getBatchById(tenantId(req), req.params['batchId']!);
    res.json({ data: batch });
  } catch (err) { next(err); }
});

// POST /v1/withdrawal-batches/:batchId/approve
const approveSchema = z.object({
  approvedBy: z.string().optional(),
});

withdrawalBatchesRouter.post('/:batchId/approve', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = approveSchema.parse(req.body);
    const approvedBy = body.approvedBy ?? ((req as any).actorContext?.actorId ?? 'unknown');
    const batch = withdrawalBatcherService.approveBatch(tenantId(req), req.params['batchId']!, approvedBy);
    res.json({ data: batch });
  } catch (err) { next(err); }
});

// POST /v1/withdrawal-batches/:batchId/reject
const rejectSchema = z.object({
  reason: z.string().min(1),
  rejectedBy: z.string().optional(),
});

withdrawalBatchesRouter.post('/:batchId/reject', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = rejectSchema.parse(req.body);
    const rejectedBy = body.rejectedBy ?? ((req as any).actorContext?.actorId ?? 'unknown');
    const batch = withdrawalBatcherService.rejectBatch(tenantId(req), req.params['batchId']!, rejectedBy, body.reason);
    res.json({ data: batch });
  } catch (err) { next(err); }
});

// POST /v1/withdrawal-batches/:batchId/retry
withdrawalBatchesRouter.post('/:batchId/retry', (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = withdrawalBatcherService.retryBatch(tenantId(req), req.params['batchId']!);
    res.json({ data: batch });
  } catch (err) { next(err); }
});

// POST /v1/withdrawal-batches/:batchId/cancel
withdrawalBatchesRouter.post('/:batchId/cancel', (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = withdrawalBatcherService.cancelBatch(tenantId(req), req.params['batchId']!);
    res.json({ data: batch });
  } catch (err) { next(err); }
});

// POST /v1/withdrawal-batches/:batchId/rbf-bump
const rbfBumpSchema = z.object({
  newFeeRateSatVb: z.number().int().positive(),
});

withdrawalBatchesRouter.post('/:batchId/rbf-bump', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const body = rbfBumpSchema.parse(req.body);
      const batch = await withdrawalBatcherService.rbfBump(
        tenantId(req),
        req.params['batchId']!,
        body.newFeeRateSatVb
      );
      res.json({ data: batch });
    } catch (err) { next(err); }
  })();
});

// POST /v1/withdrawal-batches/:batchId/cpfp
const cpfpSchema = z.object({
  targetFeeRateSatVb: z.number().int().positive().optional(),
});

withdrawalBatchesRouter.post('/:batchId/cpfp', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    try {
      const body = cpfpSchema.parse(req.body);
      const batch = await withdrawalBatcherService.cpfp(
        tenantId(req),
        req.params['batchId']!,
        body.targetFeeRateSatVb
      );
      res.json({ data: batch });
    } catch (err) { next(err); }
  })();
});

// ---- Tenant batch config ----

// GET /v1/tenant/withdrawal-batch-config
withdrawalBatchConfigRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = withdrawalBatcherService.getBatchConfig(tenantId(req));
    res.json({ data: config });
  } catch (err) { next(err); }
});

// PATCH /v1/tenant/withdrawal-batch-config
const configPatchSchema = z.object({
  btcBatchingEnabled: z.boolean().optional(),
  btcBatchIntervalSeconds: z.number().int().positive().optional(),
  btcMaxOutputsPerBatch: z.number().int().positive().max(500).optional(),
  btcMinOutputsPerBatch: z.number().int().min(1).optional(),
  btcMaxBatchAgeSeconds: z.number().int().positive().optional(),
  btcMaxBatchTotalSats: z.string().optional(),
  btcMaxSingleWithdrawalSats: z.string().optional(),
  btcMinWithdrawalSats: z.string().optional(),
  btcFeePolicy: z.enum(['target_blocks', 'fixed']).optional(),
  btcTargetBlocks: z.number().int().min(1).max(1008).optional(),
  btcMaxFeeRateSatVb: z.number().int().positive().optional(),
  btcMinFeeRateSatVb: z.number().int().positive().optional(),
  btcFeeSanityMaxFeeSats: z.string().optional(),
  btcFeeSanityMaxFeePercentBps: z.number().int().positive().optional(),
  btcDustPolicy: z.enum(['reject', 'manual_review', 'aggregate']).optional(),
  btcRbfEnabled: z.boolean().optional(),
  btcCpfpEnabled: z.boolean().optional(),
  btcBatchRetryMaxAttempts: z.number().int().min(0).max(10).optional(),
  withdrawalFeeCoverage: z.enum(['tenant_pays', 'sender_pays', 'recipient_pays']).optional(),
}).strict();

withdrawalBatchConfigRouter.patch('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = configPatchSchema.parse(req.body);

    // Convert camelCase to snake_case
    const updates: Record<string, unknown> = {};
    const map: Record<string, string> = {
      btcBatchingEnabled: 'btc_batching_enabled',
      btcBatchIntervalSeconds: 'btc_batch_interval_seconds',
      btcMaxOutputsPerBatch: 'btc_max_outputs_per_batch',
      btcMinOutputsPerBatch: 'btc_min_outputs_per_batch',
      btcMaxBatchAgeSeconds: 'btc_max_batch_age_seconds',
      btcMaxBatchTotalSats: 'btc_max_batch_total_sats',
      btcMaxSingleWithdrawalSats: 'btc_max_single_withdrawal_sats',
      btcMinWithdrawalSats: 'btc_min_withdrawal_sats',
      btcFeePolicy: 'btc_fee_policy',
      btcTargetBlocks: 'btc_target_blocks',
      btcMaxFeeRateSatVb: 'btc_max_fee_rate_sat_vb',
      btcMinFeeRateSatVb: 'btc_min_fee_rate_sat_vb',
      btcFeeSanityMaxFeeSats: 'btc_fee_sanity_max_fee_sats',
      btcFeeSanityMaxFeePercentBps: 'btc_fee_sanity_max_fee_percent_bps',
      btcDustPolicy: 'btc_dust_policy',
      btcRbfEnabled: 'btc_rbf_enabled',
      btcCpfpEnabled: 'btc_cpfp_enabled',
      btcBatchRetryMaxAttempts: 'btc_batch_retry_max_attempts',
      withdrawalFeeCoverage: 'withdrawal_fee_coverage',
    };

    for (const [camel, snake] of Object.entries(map)) {
      const val = (body as any)[camel];
      if (val !== undefined) {
        updates[snake] = typeof val === 'boolean' ? (val ? 1 : 0) : val;
      }
    }

    const config = withdrawalBatcherService.upsertBatchConfig(tenantId(req), updates as any);
    res.json({ data: config });
  } catch (err) { next(err); }
});
