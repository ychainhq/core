import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { monitorsService } from './monitors.service';

export const monitorsRouter = Router();

const addSchema = z.object({
  chain: z.string().min(1),
  address: z.string().min(1),
  label: z.string().max(200).optional(),
  walletId: z.string().optional(),
  events: z.array(z.string()).optional(),
  webhookId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  chain: z.string().optional(),
  walletId: z.string().optional(),
  isActive: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

// POST /v1/monitors/addresses
monitorsRouter.post('/addresses', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const body = addSchema.parse(req.body);
    const monitor = monitorsService.add(tenantId, body);
    res.status(201).json({ data: monitor });
  } catch (err) {
    next(err);
  }
});

// GET /v1/monitors/addresses
monitorsRouter.get('/addresses', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const query = listQuerySchema.parse(req.query);
    const result = monitorsService.list(tenantId, query);
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

// DELETE /v1/monitors/addresses/:monitorId
monitorsRouter.delete('/addresses/:monitorId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const monitor = monitorsService.deactivate(tenantId, req.params['monitorId']!);
    res.json({ data: monitor });
  } catch (err) {
    next(err);
  }
});
