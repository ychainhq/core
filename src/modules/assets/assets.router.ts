import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { assetsService } from './assets.service';

export const assetsRouter = Router();

const listQuerySchema = z.object({
  chain: z.string().optional(),
  type: z.string().optional(),
});

assetsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const assets = assetsService.list({ chain: query.chain, type: query.type });
    res.json({ data: assets });
  } catch (err) {
    next(err);
  }
});
