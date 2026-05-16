import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { walletsService } from './wallets.service';

export const walletsRouter = Router();

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
    res.status(201).json({ data: wallet });
  } catch (err) {
    next(err);
  }
});

walletsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
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
