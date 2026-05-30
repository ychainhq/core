import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { addressesService } from './addresses.service';
import { adapterRegistry } from '../../chain-adapters/registry';
import { detectAddressType } from '../../shared/validation/bitcoin';
import { config } from '../../config/index';
import { ticklerService } from '../../shared/tickler/tickler.service';
import { resolveActorLogin } from '../../shared/tickler/tickler.actor';

export const addressesRouter = Router({ mergeParams: true });
export const validateAddressRouter = Router({ mergeParams: true });
export const resolveAddressRouter = Router({ mergeParams: true });

const addAddressSchema = z.object({
  chain: z.string().min(1),
  address: z.string().min(1),
  label: z.string().max(200).optional(),
  addressType: z.string().optional(),
  addressRole: z.string().optional(),
  customerId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const validateSchema = z.object({
  address: z.string().min(1),
});

// POST /v1/chains/:chain/addresses/validate
validateAddressRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const chain = req.params['chain']!;
    const body = validateSchema.parse(req.body);
    const adapter = adapterRegistry.get(chain);
    const valid = adapter.isValidAddress(body.address);

    let format: string | undefined;
    if (chain === 'bitcoin') {
      format = detectAddressType(body.address, config.BITCOIN_NETWORK) ?? undefined;
    }

    res.json({
      data: {
        valid,
        address: body.address,
        chain,
        format,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/wallets/:walletId/addresses
addressesRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const walletId = req.params['walletId']!;
    const body = addAddressSchema.parse(req.body);
    const address = addressesService.addToWallet(tenantId, walletId, {
      ...body,
      customerId: body.customerId,
    });
    ticklerService.record({
      tenantId,
      category: 'address',
      subcategory: 'registered',
      entityId: address.id,
      actorLogin: resolveActorLogin(req),
      field1: address.chain_id,
      field2: walletId,
      field3: body.customerId ?? null,
      newValue: address,
    });
    res.status(201).json({ data: address });
  } catch (err) {
    next(err);
  }
});

// GET /v1/addresses/resolve?address=<addr>
// Returns whether the given address is a registered platform deposit address for this tenant.
resolveAddressRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const { address } = z.object({ address: z.string().min(1) }).parse(req.query);
    const { getDb } = require('../../db/sqlite');
    const db = getDb();
    const row = db
      .prepare("SELECT customer_id FROM addresses WHERE address = ? AND tenant_id = ? AND address_role = 'customer_deposit' LIMIT 1")
      .get(address, tenantId) as { customer_id: string } | undefined;
    res.json({ data: { isInternal: !!row, customerId: row?.customer_id ?? null } });
  } catch (err) {
    next(err);
  }
});

// GET /v1/wallets/:walletId/addresses
addressesRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const walletId = req.params['walletId']!;
    const query = listQuerySchema.parse(req.query);
    const result = addressesService.listByWallet(tenantId, walletId, query);
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
