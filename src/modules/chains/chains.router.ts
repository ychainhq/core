import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { chainsService } from './chains.service';

export const chainsRouter = Router();

const listQuerySchema = z.object({
  enabled: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  type: z.string().optional(),
});

chainsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const chains = chainsService.list({ enabled: query.enabled, type: query.type });
    res.json({ data: chains });
  } catch (err) {
    next(err);
  }
});

chainsRouter.get('/:chain', (req: Request, res: Response, next: NextFunction) => {
  try {
    const chain = chainsService.getById(req.params['chain']!);
    res.json({ data: chain });
  } catch (err) {
    next(err);
  }
});
