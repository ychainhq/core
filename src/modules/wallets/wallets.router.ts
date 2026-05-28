import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { walletsService } from './wallets.service';
import { resolvePermission } from '../../shared/actor-auth/context';
import { ApiError } from '../../shared/errors/index';
import { ticklerService } from '../../shared/tickler/tickler.service';
import { resolveActorLogin } from '../../shared/tickler/tickler.actor';

export const walletsRouter = Router();

function checkActorAccess(req: Request, entity: string, action: 'read' | 'write'): void {
  const ctx = (req as any).actorContext;
  if (!ctx) return; // No X-Actor-Token = admin mode, pass through
  const resolved = resolvePermission(ctx, entity, action);
  if (resolved.level === 'none') {
    throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', `Actor lacks ${entity}:${action} permission`);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['watch_only', 'external_signer']),
  walletRole: z.enum(['watch_only', 'tenant_hot', 'tenant_cold', 'customer_deposits', 'external_signer']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  type: z.string().optional(),
});

walletsRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const body = createSchema.parse(req.body);
    const wallet = walletsService.create(tenantId, body);
    ticklerService.record({
      tenantId,
      category: 'wallet',
      subcategory: 'created',
      entityId: wallet.id,
      actorLogin: resolveActorLogin(req),
      field1: wallet.wallet_role,
      field2: wallet.name,
      newValue: wallet,
    });
    res.status(201).json({ data: wallet });
  } catch (err) {
    next(err);
  }
});

walletsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    checkActorAccess(req, 'wallet', 'read');
    const tenantId = (req as any).tenantId as string;
    const query = listQuerySchema.parse(req.query);
    const result = walletsService.list(tenantId, query);
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

walletsRouter.get('/:walletId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const wallet = walletsService.getById(tenantId, req.params['walletId']!);
    res.json({ data: wallet });
  } catch (err) {
    next(err);
  }
});
