import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tenantsService } from './tenants.service';
import { ticklerService } from '../../shared/tickler/tickler.service';
import { resolveActorLogin } from '../../shared/tickler/tickler.actor';

export const tenantsAdminRouter = Router();

// Per-chain asset configuration schemas.
// Add new chain schemas here when additional chains are supported.
const btcAssetSchema = z.object({
  chain: z.literal('bitcoin'),
  hotAddress: z.string().min(1),
  coldAddress: z.string().min(1).optional(),
  xpub: z.string().min(1).optional(),
});

// Discriminated union on 'chain' — extend with z.union([btcAssetSchema, ethAssetSchema, ...]) when ETH is added.
const assetConfigSchema = btcAssetSchema;

const createSchema = z.object({
  name: z.string().min(1).max(200),
  metadata: z.record(z.unknown()).optional(),
  assets: z.array(assetConfigSchema).min(1),
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
  customerSessionTtlSeconds: z.coerce.number().int().min(60).max(86400).optional(),
  btcHotAddress: z.string().min(1).optional(),
  btcColdAddress: z.string().min(1).optional(),
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
    await tenantsService.provision(tenant.id, body.assets);
    ticklerService.record({
      tenantId: null,
      category: 'platform',
      subcategory: 'tenant.created',
      entityId: tenant.id,
      actorLogin: resolveActorLogin(req),
      field1: tenant.name,
      newValue: tenant,
    });
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
    const prev = tenantsService.getById(req.params['tenantId']!);
    const tenant = tenantsService.update(req.params['tenantId']!, body);
    ticklerService.record({
      tenantId: null,
      category: 'platform',
      subcategory: body.status && body.status !== prev.status ? 'tenant.suspended' : 'tenant.updated',
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
tenantsAdminRouter.patch('/:tenantId/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = configSchema.parse(req.body);
    const prev = tenantsService.getById(req.params['tenantId']!);
    const tenantConfig = await tenantsService.updateConfig(req.params['tenantId']!, body);
    ticklerService.record({
      tenantId: null,
      category: 'platform',
      subcategory: 'tenant.config_updated',
      entityId: req.params['tenantId']!,
      actorLogin: resolveActorLogin(req),
      prevValue: prev.config,
      newValue: tenantConfig,
    });
    res.json({ data: tenantConfig });
  } catch (err) {
    next(err);
  }
});

// POST /admin/v1/tenants/:tenantId/api-keys
tenantsAdminRouter.post('/:tenantId/api-keys', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = apiKeySchema.parse(req.body);
    const result = tenantsService.generateApiKey(req.params['tenantId']!, body.name);
    ticklerService.record({
      tenantId: null,
      category: 'platform',
      subcategory: 'tenant.api_key_created',
      entityId: req.params['tenantId']!,
      actorLogin: resolveActorLogin(req),
      field1: result.keyId,
      field2: body.name,
      newValue: { keyId: result.keyId, name: body.name },
    });
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
