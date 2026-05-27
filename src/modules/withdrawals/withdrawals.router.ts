import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { withdrawalsService } from './withdrawals.service';
import { customersService } from '../customers/customers.service';
import { ApiError } from '../../shared/errors/index';
import { AccessFilter } from '../../shared/actor-auth/types';
import { resolvePermission } from '../../shared/actor-auth/context';
import { buildAccessFilter, adminAllFilter } from '../../shared/actor-auth/filter';

export const withdrawalsRouter = Router();

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

/**
 * Builds customer access filter from X-Actor-Token.
 * No token → full tenant access. Token with no customer:read → 403.
 */
function getCustomerAccessFilter(req: Request, action: 'read' | 'write'): AccessFilter {
  const ctx = (req as any).actorContext;
  if (!ctx) return adminAllFilter(tenantId(req));
  const resolved = resolvePermission(ctx, 'customer', action);
  if (resolved.level === 'none') {
    throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', `Actor lacks customer:${action} permission`);
  }
  return buildAccessFilter(resolved, ctx);
}

const listQuerySchema = z.object({
  status: z.string().optional(),
  customerId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const submitSignedSchema = z.object({
  signedPsbt: z.string().min(1),
});

// GET /v1/withdrawals — tenant-level view of all customer withdrawals
withdrawalsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const filters = { status: query.status, limit: query.limit, cursor: query.cursor };
    const accessFilter = getCustomerAccessFilter(req, 'read');
    let result;
    if (query.customerId) {
      // Validate actor has access to this customer before returning their withdrawals.
      // Throws NotFoundError (404) if actor's RBAC scope excludes this customer.
      customersService.getById(tenantId(req), query.customerId, accessFilter);
      result = withdrawalsService.list(tenantId(req), query.customerId, filters);
    } else {
      result = withdrawalsService.listForTenant(tenantId(req), filters);
    }
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/withdrawals/:withdrawalId
withdrawalsRouter.get('/:withdrawalId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const withdrawal = withdrawalsService.getById(tenantId(req), req.params['withdrawalId']!);
    res.json({ data: withdrawal });
  } catch (err) {
    next(err);
  }
});

// POST /v1/withdrawals/:withdrawalId/submit-signed
// Called by the tenant's signing daemon after signing the PSBT from the webhook.
withdrawalsRouter.post('/:withdrawalId/submit-signed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = submitSignedSchema.parse(req.body);
    const updated = await withdrawalsService.submitSigned(
      tenantId(req),
      req.params['withdrawalId']!,
      body.signedPsbt
    );
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});
