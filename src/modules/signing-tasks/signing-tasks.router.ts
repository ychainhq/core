/**
 * Signing Tasks Router
 *
 * Tenant/UI endpoints for managing signing tasks.
 *
 * GET  /v1/signing-tasks
 * GET  /v1/signing-tasks/:taskId
 * POST /v1/signing-tasks/:taskId/approve
 * POST /v1/signing-tasks/:taskId/reject
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { signingTasksService } from './signing-tasks.service';

export const signingTasksRouter = Router();

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

// GET /v1/signing-tasks
signingTasksRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt((req.query['limit'] as string) || '20', 10);
    const cursor = req.query['cursor'] as string | undefined;
    const status = req.query['status'] as string | undefined;
    const chainId = req.query['chainId'] as string | undefined;

    const result = signingTasksService.list(tenantId(req), { status, chainId, limit, cursor });
    res.json({
      data: result.data,
      pagination: { limit, cursor: cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) { next(err); }
});

// GET /v1/signing-tasks/:taskId
signingTasksRouter.get('/:taskId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = signingTasksService.getById(tenantId(req), req.params['taskId']!);
    res.json({ data: task });
  } catch (err) { next(err); }
});

// POST /v1/signing-tasks/:taskId/approve
const approveSchema = z.object({
  approvedBy: z.string().min(1).optional(),
});

signingTasksRouter.post('/:taskId/approve', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = approveSchema.parse(req.body);
    const approvedBy = body.approvedBy ?? ((req as any).actorContext?.actorId ?? 'unknown');
    const task = signingTasksService.approveTask(tenantId(req), req.params['taskId']!, approvedBy);
    res.json({ data: task });
  } catch (err) { next(err); }
});

// POST /v1/signing-tasks/:taskId/reject
const rejectSchema = z.object({
  reason: z.string().min(1),
  rejectedBy: z.string().min(1).optional(),
});

signingTasksRouter.post('/:taskId/reject', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = rejectSchema.parse(req.body);
    const rejectedBy = body.rejectedBy ?? ((req as any).actorContext?.actorId ?? 'unknown');
    const task = signingTasksService.manualRejectTask(tenantId(req), req.params['taskId']!, rejectedBy, body.reason);
    res.json({ data: task });
  } catch (err) { next(err); }
});
