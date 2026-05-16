import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { adapterRegistry } from '../../chain-adapters/registry';

export const feesRouter = Router();

const feeQuerySchema = z.object({
  priority: z.enum(['low', 'normal', 'high']).optional(),
  targetBlocks: z.coerce.number().int().min(1).optional(),
});

// GET /v1/chains/bitcoin/fees
feesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    feeQuerySchema.parse(req.query);
    const adapter = adapterRegistry.get('bitcoin');

    // Estimate for 3 priority levels: low (12 blocks), normal (6 blocks), high (2 blocks)
    const [low, normal, high] = await Promise.all([
      adapter.estimateSmartFee(12).catch(() => ({ feeRate: 1, targetBlocks: 12, mode: 'conservative' })),
      adapter.estimateSmartFee(6).catch(() => ({ feeRate: 2, targetBlocks: 6, mode: 'conservative' })),
      adapter.estimateSmartFee(2).catch(() => ({ feeRate: 5, targetBlocks: 2, mode: 'conservative' })),
    ]);

    res.json({
      data: {
        feeRates: {
          low: {
            feeRate: low.feeRate,
            targetBlocks: low.targetBlocks,
          },
          normal: {
            feeRate: normal.feeRate,
            targetBlocks: normal.targetBlocks,
          },
          high: {
            feeRate: high.feeRate,
            targetBlocks: high.targetBlocks,
          },
        },
        unit: 'sat/vbyte',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});
