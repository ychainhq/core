import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ticklerService } from '../../shared/tickler/tickler.service';
import { authMiddleware } from '../../shared/auth/middleware';
import { adminAuthMiddleware } from '../../shared/admin-auth/middleware';
import { NotFoundError, ValidationError } from '../../shared/errors/index';

const querySchema = z.object({
  category:     z.string().optional(),
  subcategory:  z.string().optional(),
  entity_id:    z.string().optional(),
  actor_login:  z.string().optional(),
  from:         z.coerce.number().int().optional(),
  to:           z.coerce.number().int().optional(),
  limit:        z.coerce.number().int().min(1).max(500).default(50),
  cursor:       z.string().optional(),
});

// GET /v1/ticklers  (tenant-scoped)
export const tenantTicklersRouter = Router();

tenantTicklersRouter.use(authMiddleware);

tenantTicklersRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) throw new Error('tenantId missing from request context');

    const query = querySchema.parse(req.query);
    const result = ticklerService.list({
      tenantId,
      includeGlobal: false,
      ...query,
      entityId: query.entity_id,
      actorLogin: query.actor_login,
    });

    res.json({
      data: result.data,
      pagination: { limit: query.limit, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/v1/ticklers           (all ticklers — global + all tenants)
// GET /admin/v1/tenants/:tenantId/ticklers  (ticklers for one tenant)
export const adminTicklersRouter = Router();

adminTicklersRouter.use(adminAuthMiddleware);

adminTicklersRouter.get('/ticklers', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = querySchema.parse(req.query);
    const tenantFilter = req.query['tenantId'] as string | undefined;
    const result = ticklerService.list({
      tenantId: tenantFilter,
      includeGlobal: true,
      ...query,
      entityId: query.entity_id,
      actorLogin: query.actor_login,
    });
    res.json({
      data: result.data,
      pagination: { limit: query.limit, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

adminTicklersRouter.get('/tenants/:tenantId/ticklers', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = req.params;
    const query = querySchema.parse(req.query);
    const result = ticklerService.list({
      tenantId,
      includeGlobal: false,
      ...query,
      entityId: query.entity_id,
      actorLogin: query.actor_login,
    });
    res.json({
      data: result.data,
      pagination: { limit: query.limit, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});
