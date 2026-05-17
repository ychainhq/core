import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tenantsService } from './tenants.service';

export const tenantsAdminRouter = Router();

// Per-chain asset configuration schemas.
// Add new chain schemas here when additional chains are supported.
const btcAssetSchema = z.object({
  chain: z.literal('bitcoin'),
  hotAddress: z.string().min(1).optional(),
  coldAddress: z.string().min(1).optional(),
  xpub: z.string().min(1).optional(),
});

// Discriminated union on 'chain' — extend with z.union([btcAssetSchema, ethAssetSchema, ...]) when ETH is added.
const assetConfigSchema = btcAssetSchema;

const createSchema = z.object({
  name: z.string().min(1).max(200),
  metadata: z.record(z.unknown()).optional(),
  assets: z.array(assetConfigSchema).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'suspended', 'disabled']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const configSchema = z.object({
  btcConfirmationsRequired: z.coerce.number().int().min(0).optional(),
  btcFinalityConfirmations: z.coerce.number().int().min(1).optional(),
  custodyMode: z.enum(['external_signer', 'platform_custody', 'hybrid_custody']).optional(),
  withdrawalMode: z.enum(['external_signer', 'automatic', 'manual_approval', 'threshold_based']).optional(),
  dailyWithdrawalLimitSats: z.string().nullable().optional(),
  perTxLimitSats: z.string().nullable().optional(),
  btcXpub: z.string().min(1).nullable().optional(),
  btcSweepThresholdSats: z.string().regex(/^\d+$/, 'Must be a numeric string').optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  status: z.string().optional(),
});

const apiKeySchema = z.object({
  name: z.string().min(1).max(200),
});

// POST /admin/v1/tenants
tenantsAdminRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createSchema.parse(req.body);
    const tenant = tenantsService.create(body);
    await tenantsService.provision(tenant.id, body.assets ?? []);
    res.status(201).json({ data: tenant });
  } catch (err) {
    next(err);
  }
});

// GET /admin/v1/tenants
tenantsAdminRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = tenantsService.list(query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/v1/tenants/:tenantId
tenantsAdminRouter.get('/:tenantId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = tenantsService.getById(req.params['tenantId']!);
    res.json({ data: tenant });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/v1/tenants/:tenantId
tenantsAdminRouter.patch('/:tenantId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateSchema.parse(req.body);
    const tenant = tenantsService.update(req.params['tenantId']!, body);
    res.json({ data: tenant });
  } catch (err) {
    next(err);
  }
});

// GET /admin/v1/tenants/:tenantId/config
tenantsAdminRouter.get('/:tenantId/config', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = tenantsService.getById(req.params['tenantId']!);
    res.json({ data: tenant.config });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/v1/tenants/:tenantId/config
tenantsAdminRouter.patch('/:tenantId/config', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = configSchema.parse(req.body);
    const config = tenantsService.updateConfig(req.params['tenantId']!, body);
    res.json({ data: config });
  } catch (err) {
    next(err);
  }
});

// POST /admin/v1/tenants/:tenantId/api-keys
tenantsAdminRouter.post('/:tenantId/api-keys', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = apiKeySchema.parse(req.body);
    const result = tenantsService.generateApiKey(req.params['tenantId']!, body.name);
    res.status(201).json({
      data: {
        keyId: result.keyId,
        apiKey: result.rawKey,
        tenantId: req.params['tenantId'],
        warning: 'Store this key securely — it will not be shown again',
      },
    });
  } catch (err) {
    next(err);
  }
});
