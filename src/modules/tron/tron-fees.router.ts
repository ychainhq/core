import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { tronFeeService } from './tron-fee.service';
import { withdrawalBatcherService } from '../withdrawal-batches/withdrawal-batcher.service';

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

export const tronFeesRouter = Router();

const querySchema = z.object({
  assetId: z.enum(['tron:TRX', 'tron:USDT']).optional(),
  amount:  z.string().regex(/^\d+$/, 'amount must be a positive integer string').optional(),
});

// GET /v1/chains/tron/fees
// Without assetId+amount: returns general fee parameters (energy price, typical estimates).
// With assetId+amount:    returns specific estimate using tenant's hot wallet.
tronFeesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = querySchema.parse(req.query);

    const tid = tenantId(req);
    const batchConfig = await withdrawalBatcherService.getBatchConfig(tid);
    const tronUsdtWithdrawalFee = batchConfig.tron_usdt_withdrawal_fee ?? '0';
    const feeCoverage = batchConfig.withdrawal_fee_coverage;

    if (query.assetId && query.amount) {
      const contractAddress = query.assetId === 'tron:USDT'
        ? (process.env['TRON_USDT_CONTRACT_ADDRESS'] ?? undefined)
        : undefined;

      const estimate = await tronFeeService.estimateFee({
        tenantId: tid,
        assetId: query.assetId,
        toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // simulation placeholder
        amountRaw: query.amount,
        contractAddress,
      });

      res.json({
        data: {
          chain: 'tron',
          assetId: query.assetId,
          // TRX gas cost — always paid by hot wallet from its TRX balance
          estimatedFeeSun: estimate.estimatedFeeSun,
          estimatedFeeTrx: (Number(estimate.estimatedFeeSun) / 1_000_000).toFixed(6),
          breakdown: {
            bandwidthNeeded: estimate.bandwidthNeeded,
            bandwidthFree: estimate.bandwidthFreeRemaining,
            bandwidthCostSun: estimate.bandwidthCostSun,
            energyNeeded: estimate.energyNeeded,
            energyFree: estimate.energyFreeRemaining,
            energyCostSun: estimate.energyCostSun,
            energyPriceSun: estimate.energyPriceSun,
            bandwidthPriceSun: estimate.bandwidthPriceSun,
          },
          feeLimitSun: estimate.recommendedFeeLimitSun,
          hotWalletHasEnoughResources: estimate.hotWalletHasEnoughResources,
          // Customer-facing USDT withdrawal fee (separate from TRX gas)
          tronUsdtWithdrawalFee,
          feeCoverage,
          timestamp: new Date().toISOString(),
        },
      });
    } else {
      const params = await tronFeeService.getGeneralFeeParams();
      res.json({ data: { chain: 'tron', ...params, tronUsdtWithdrawalFee, feeCoverage } });
    }
  } catch (err) {
    next(err);
  }
});
