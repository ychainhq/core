import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tenantsService } from './tenants.service';
import { ticklerService } from '../../shared/tickler/tickler.service';
import { resolveActorLogin } from '../../shared/tickler/tickler.actor';

export const tenantSelfRouter = Router();

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

// Only name + metadata — status is admin-only
const updateProfileSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Safe subset of config — custodyMode and btcNextDerivationIndex are intentionally omitted
const updateConfigSchema = z.object({
  btcConfirmationsRequired: z.coerce.number().int().min(0).optional(),
  btcFinalityConfirmations: z.coerce.number().int().min(1).optional(),
  withdrawalMode: z.enum(['external_signer', 'automatic', 'manual_approval', 'threshold_based']).optional(),
  dailyWithdrawalLimitSats: z.string().nullable().optional(),
  perTxLimitSats: z.string().nullable().optional(),
  btcXpub: z.string().min(1).nullable().optional(),
  btcSweepThresholdSats: z.string().regex(/^\d+$/, 'Must be a numeric string').optional(),
  customerSessionTtlSeconds: z.coerce.number().int().min(60).max(86400).optional(),
  /** HMAC secret used to verify X-Actor-Token JWTs. Min 32 chars. Set null to disable. */
  actorTokenSecret: z.string().min(32).nullable().optional(),
});

// GET /v1/tenant
tenantSelfRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = tenantsService.getById(tenantId(req));
    res.json({ data: tenant });
  } catch (err) {
    next(err);
  }
});

// PATCH /v1/tenant
tenantSelfRouter.patch('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateProfileSchema.parse(req.body);
    const prev = tenantsService.getById(tenantId(req));
    const tenant = tenantsService.update(tenantId(req), body);
    ticklerService.record({
      tenantId: tenantId(req),
      category: 'tenant',
      subcategory: 'self.updated',
      entityId: tenant.id,
      actorLogin: resolveActorLogin(req),
      prevValue: prev,
      newValue: tenant,
    });
    res.json({ data: tenant });
  } catch (err) {
    next(err);
  }
});

// GET /v1/tenant/config
tenantSelfRouter.get('/config', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = tenantsService.getById(tenantId(req));
    res.json({ data: tenant.config });
  } catch (err) {
    next(err);
  }
});

// PATCH /v1/tenant/config
tenantSelfRouter.patch('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateConfigSchema.parse(req.body);
    const prev = tenantsService.getById(tenantId(req));
    const cfg = await tenantsService.updateConfig(tenantId(req), body);
    ticklerService.record({
      tenantId: tenantId(req),
      category: 'tenant',
      subcategory: 'config.updated',
      entityId: tenantId(req),
      actorLogin: resolveActorLogin(req),
      prevValue: prev.config,
      newValue: cfg,
    });
    res.json({ data: cfg });
  } catch (err) {
    next(err);
  }
});
