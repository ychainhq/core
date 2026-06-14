/**
 * TronFeeService — dynamic fee estimation for TRON transactions.
 *
 * TRON fee model:
 *   TRX transfer:  bandwidth only (tx_size_bytes × bandwidth_price_sun)
 *   TRC-20 (USDT): bandwidth + energy (energy_used × energy_price_sun)
 *
 * Fee components:
 *   - bandwidthCostSun: 0 if free daily allowance or staked bandwidth covers tx size
 *   - energyCostSun:    0 for TRX tx; 0 if staked energy covers energy_used
 *   - estimatedFeeSun:  sum of both — the actual cost to store as feeRaw
 *   - recommendedFeeLimitSun: safety cap for triggersmartcontract (fee_limit param),
 *     set to energyNeeded × energyPrice × 1.5. NOT the same as estimatedFeeSun.
 *
 * Two TTL caches:
 *   chainParams  — 60 s (energy price changes rarely)
 *   accountRes   — 15 s per address (staking resources fluctuate within day)
 */

import { getDbClient } from '../../db/client';
import { TronRpcClient } from '../../chain-adapters/tron/rpc-client';
import { NodeSelector } from '../../chain-adapters/node-selector';
import { TronChainParams, TronAccountResource, TronFeeEstimate } from '../../chain-adapters/tron/tron-types';
import { config } from '../../config/index';
import { logger } from '../../shared/logging/index';

// ── Constants ────────────────────────────────────────────────────────────────

const CHAIN_PARAMS_TTL_MS = 60_000;
const ACCOUNT_RES_TTL_MS  = 15_000;

// Minimum fee_limit passed to triggersmartcontract regardless of estimate.
const MIN_FEE_LIMIT_SUN = 10_000_000; // 10 TRX

// Safety multiplier on top of energy estimate for fee_limit cap.
const FEE_LIMIT_BUFFER_FACTOR = 1.5;

// Fallback tx size when simulation is unavailable.
const FALLBACK_TRC20_TX_SIZE_BYTES = 285;
const FALLBACK_TRX_TX_SIZE_BYTES   = 185;

// Typical energy for a USDT TRC-20 transfer (used in general params response).
const TYPICAL_USDT_ENERGY = 65_000;

// ── Cache ─────────────────────────────────────────────────────────────────────

let chainParamsCache: { value: TronChainParams; expiresAt: number } | null = null;
const accountResCache = new Map<string, { value: TronAccountResource; expiresAt: number }>();

// ── Internal helpers ──────────────────────────────────────────────────────────

function makeTronRpc(): TronRpcClient {
  const fallback = config.TRON_NODE_URL
    ? { url: config.TRON_NODE_URL, timeoutMs: 10_000, maxAttempts: 2, retryDelayMs: 500 }
    : null;
  return new TronRpcClient(new NodeSelector('tron', fallback));
}

async function fetchChainParams(rpc: TronRpcClient): Promise<TronChainParams> {
  const now = Date.now();
  if (chainParamsCache && chainParamsCache.expiresAt > now) {
    return chainParamsCache.value;
  }
  const params = await rpc.getChainParameters();
  chainParamsCache = { value: params, expiresAt: now + CHAIN_PARAMS_TTL_MS };
  return params;
}

async function fetchAccountResource(rpc: TronRpcClient, address: string): Promise<TronAccountResource> {
  const now = Date.now();
  const cached = accountResCache.get(address);
  if (cached && cached.expiresAt > now) return cached.value;
  const resource = await rpc.getAccountResource(address);
  accountResCache.set(address, { value: resource, expiresAt: now + ACCOUNT_RES_TTL_MS });
  return resource;
}

function computeFeeSun(
  txSizeBytes: number,
  energyUsed: number,
  resource: TronAccountResource,
  chainParams: TronChainParams,
): {
  bandwidthCostSun: bigint;
  energyCostSun: bigint;
  bandwidthFreeRemaining: number;
  energyFreeRemaining: number;
} {
  const remainingBP =
    Math.max(0, resource.freeNetLimit - resource.freeNetUsed) +
    Math.max(0, resource.netLimit - resource.netUsed);

  const bandwidthNeeded = Math.max(0, txSizeBytes - remainingBP);
  const bandwidthCostSun = BigInt(bandwidthNeeded) * BigInt(chainParams.bandwidthPriceSun);

  const remainingEnergy = Math.max(0, resource.energyLimit - resource.energyUsed);
  const energyToBurn = Math.max(0, energyUsed - remainingEnergy);
  const energyCostSun = BigInt(energyToBurn) * BigInt(chainParams.energyPriceSun);

  return {
    bandwidthCostSun,
    energyCostSun,
    bandwidthFreeRemaining: remainingBP,
    energyFreeRemaining: remainingEnergy,
  };
}

function buildFeeEstimate(params: {
  assetId: string;
  txSizeBytes: number;
  energyUsed: number;
  resource: TronAccountResource;
  chainParams: TronChainParams;
}): TronFeeEstimate {
  const { assetId, txSizeBytes, energyUsed, resource, chainParams } = params;
  const { bandwidthCostSun, energyCostSun, bandwidthFreeRemaining, energyFreeRemaining } =
    computeFeeSun(txSizeBytes, energyUsed, resource, chainParams);

  const estimatedFeeSun = bandwidthCostSun + energyCostSun;

  const recommendedFeeLimitSun = energyUsed > 0
    ? Math.max(
        Math.ceil(energyUsed * chainParams.energyPriceSun * FEE_LIMIT_BUFFER_FACTOR),
        MIN_FEE_LIMIT_SUN,
      )
    : 0;

  return {
    estimatedFeeSun: estimatedFeeSun.toString(),
    bandwidthCostSun: bandwidthCostSun.toString(),
    energyCostSun: energyCostSun.toString(),
    bandwidthNeeded: txSizeBytes,
    bandwidthFreeRemaining,
    energyNeeded: energyUsed,
    energyFreeRemaining,
    energyPriceSun: chainParams.energyPriceSun,
    bandwidthPriceSun: chainParams.bandwidthPriceSun,
    recommendedFeeLimitSun,
    hotWalletHasEnoughResources: estimatedFeeSun === 0n,
    assetId,
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

export const tronFeeService = {
  /**
   * Estimate fee using the tenant's hot wallet address (resolved from DB).
   * Use this in batcher and sweep worker — they know tenantId but not fromAddress.
   */
  async estimateFee(params: {
    tenantId: string;
    assetId: 'tron:TRX' | 'tron:USDT';
    toAddress: string;
    amountRaw: string;
    contractAddress?: string;
  }): Promise<TronFeeEstimate> {
    const db = getDbClient();
    const hotAddrRow = await db.get<{ address: string }>(`
      SELECT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
        AND a.chain_id = 'tron' AND a.status = 'active'
      LIMIT 1
    `, [params.tenantId]);

    if (!hotAddrRow) {
      logger.warn('tronFeeService.estimateFee: no TRON hot wallet — returning zero-cost estimate', {
        tenantId: params.tenantId,
      });
      return tronFeeService._zeroFeeEstimate(params.assetId);
    }

    return tronFeeService.estimateFeeForAddress({
      fromAddress: hotAddrRow.address,
      assetId: params.assetId,
      toAddress: params.toAddress,
      amountRaw: params.amountRaw,
      contractAddress: params.contractAddress,
    });
  },

  /**
   * Estimate fee for a known fromAddress.
   * Use this in the REST endpoint and for testing.
   */
  async estimateFeeForAddress(params: {
    fromAddress: string;
    assetId: 'tron:TRX' | 'tron:USDT';
    toAddress: string;
    amountRaw: string;
    contractAddress?: string;
  }): Promise<TronFeeEstimate> {
    const { fromAddress, assetId, toAddress, amountRaw, contractAddress } = params;
    const rpc = makeTronRpc();

    const [chainParams, resource] = await Promise.all([
      fetchChainParams(rpc),
      fetchAccountResource(rpc, fromAddress),
    ]);

    if (assetId === 'tron:TRX') {
      // TRX transfer: bandwidth only, no energy
      let txSizeBytes = FALLBACK_TRX_TX_SIZE_BYTES;
      try {
        const tx = await rpc.createUnsignedTrxTransfer({
          fromAddress,
          toAddress,
          amountSun: amountRaw,
        });
        txSizeBytes = tx.raw_data_hex ? Math.ceil(tx.raw_data_hex.length / 2) : FALLBACK_TRX_TX_SIZE_BYTES;
      } catch (err) {
        logger.warn('tronFeeService: TRX createtransaction failed, using fallback size', { error: String(err) });
      }

      return buildFeeEstimate({ assetId, txSizeBytes, energyUsed: 0, resource, chainParams });
    }

    // TRC-20 (e.g. tron:USDT): bandwidth + energy
    if (!contractAddress) {
      logger.warn('tronFeeService: no contractAddress for TRC-20 fee estimate — using fallback values');
      return buildFeeEstimate({
        assetId,
        txSizeBytes: FALLBACK_TRC20_TX_SIZE_BYTES,
        energyUsed: TYPICAL_USDT_ENERGY,
        resource,
        chainParams,
      });
    }

    let txSizeBytes = FALLBACK_TRC20_TX_SIZE_BYTES;
    let energyUsed = TYPICAL_USDT_ENERGY;

    try {
      const sim = await rpc.simulateTrc20Transfer({
        ownerAddress: fromAddress,
        contractAddress,
        toAddress,
        amount: BigInt(amountRaw),
        feeLimit: Math.max(
          Math.ceil(TYPICAL_USDT_ENERGY * chainParams.energyPriceSun * FEE_LIMIT_BUFFER_FACTOR),
          MIN_FEE_LIMIT_SUN,
        ),
      });
      txSizeBytes = sim.txSizeBytes;
      energyUsed = sim.energyUsed;
    } catch (err) {
      logger.warn('tronFeeService: triggerconstantcontract simulation failed, using fallback values', {
        error: String(err),
      });
    }

    return buildFeeEstimate({ assetId, txSizeBytes, energyUsed, resource, chainParams });
  },

  /**
   * General fee parameters without hot wallet context.
   * Used by GET /v1/chains/tron/fees without query params.
   */
  async getGeneralFeeParams(): Promise<{
    energyPriceSun: number;
    bandwidthPriceSun: number;
    typical: {
      trxTransfer: { feeSun: string; feeTrx: string };
      usdtTransfer: { feeSun: string; feeTrx: string };
    };
    note: string;
    timestamp: string;
  }> {
    const rpc = makeTronRpc();
    const chainParams = await fetchChainParams(rpc);

    const trxFeeSun = BigInt(FALLBACK_TRX_TX_SIZE_BYTES) * BigInt(chainParams.bandwidthPriceSun);
    const usdtFeeSun = BigInt(TYPICAL_USDT_ENERGY) * BigInt(chainParams.energyPriceSun);

    return {
      energyPriceSun: chainParams.energyPriceSun,
      bandwidthPriceSun: chainParams.bandwidthPriceSun,
      typical: {
        trxTransfer: {
          feeSun: trxFeeSun.toString(),
          feeTrx: (Number(trxFeeSun) / 1_000_000).toFixed(6),
        },
        usdtTransfer: {
          feeSun: usdtFeeSun.toString(),
          feeTrx: (Number(usdtFeeSun) / 1_000_000).toFixed(6),
        },
      },
      note: 'Typical estimates assume no staked bandwidth/energy. Actual fee may be 0 if hot wallet has staked resources.',
      timestamp: new Date().toISOString(),
    };
  },

  /** Returns a zero-cost estimate (used when no hot wallet is configured). */
  _zeroFeeEstimate(assetId: string): TronFeeEstimate {
    return {
      estimatedFeeSun: '0',
      bandwidthCostSun: '0',
      energyCostSun: '0',
      bandwidthNeeded: 0,
      bandwidthFreeRemaining: 0,
      energyNeeded: 0,
      energyFreeRemaining: 0,
      energyPriceSun: 420,
      bandwidthPriceSun: 1000,
      recommendedFeeLimitSun: MIN_FEE_LIMIT_SUN,
      hotWalletHasEnoughResources: true,
      assetId,
    };
  },

  /** Expose for testing. */
  _clearCache() {
    chainParamsCache = null;
    accountResCache.clear();
  },
};
