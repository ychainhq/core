import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { depositsService } from './deposits.service';

export const depositsRouter = Router();
export const addressDepositsRouter = Router({ mergeParams: true });

const listQuerySchema = z.object({
  walletId: z.string().optional(),
  chain: z.string().optional(),
  status: z.string().optional(),
  address: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

// GET /v1/deposits
depositsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const query = listQuerySchema.parse(req.query);
    const result = depositsService.list(tenantId, query);
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

// GET /v1/deposits/:depositId
depositsRouter.get('/:depositId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const deposit = depositsService.getById(tenantId, req.params['depositId']!);
    res.json({ data: deposit });
  } catch (err) {
    next(err);
  }
});

// GET /v1/chains/:chain/addresses/:address/deposits
addressDepositsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const { chain, address } = req.params as { chain: string; address: string };
    const query = listQuerySchema.parse(req.query);
    const result = depositsService.list(tenantId, { ...query, chain, address });
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
