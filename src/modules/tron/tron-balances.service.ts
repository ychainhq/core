import { getDbClient } from '../../db/client';
import { adapterRegistry } from '../../chain-adapters/registry';
import { TronAdapter } from '../../chain-adapters/tron/adapter';
import { addSatoshi } from '../../shared/money/index';
import { config } from '../../config/index';
import { logger } from '../../shared/logging/index';

export interface TronWalletBalances {
  trxSun: string;
  usdtSun: string;
  stale: boolean;
  cacheUpdatedAt: number | null;
}

const STALE_THRESHOLD_MS = 10 * 60 * 1000;
const LIVE_RPC_FALLBACK_ADDRESS_LIMIT = 10;

export const tronBalancesService = {
  async getWalletBalances(walletId: string): Promise<TronWalletBalances> {
    const db = getDbClient();

    // Fetch balance cache for all active TRON addresses in this wallet.
    const rows = await db.all<{ asset_id: string; balance_raw: string; updated_at: number }>(
      `SELECT tab.asset_id, tab.balance_raw, tab.updated_at
       FROM addresses a
       JOIN tron_account_balances tab ON tab.address = a.address
       WHERE a.wallet_id = ? AND a.chain_id = 'tron' AND a.status = 'active'`,
      [walletId],
    );

    if (rows.length > 0) {
      return buildFromCache(rows);
    }

    // Cache miss — check how many addresses this wallet has.
    const addrRows = await db.all<{ address: string }>(
      "SELECT address FROM addresses WHERE wallet_id = ? AND chain_id = 'tron' AND status = 'active'",
      [walletId],
    );

    if (addrRows.length === 0) {
      return { trxSun: '0', usdtSun: '0', stale: false, cacheUpdatedAt: null };
    }

    if (addrRows.length > LIVE_RPC_FALLBACK_ADDRESS_LIMIT) {
      // Cache not yet populated and wallet is too large for live RPC.
      // Return zeros with stale=true; TronBalanceRefreshWorker will populate cache.
      logger.warn('tronBalancesService: cache miss on large wallet, returning zeros', { walletId, addresses: addrRows.length });
      return { trxSun: '0', usdtSun: '0', stale: true, cacheUpdatedAt: null };
    }

    // Small wallet — fall back to live RPC (same as original implementation).
    return liveRpcFallback(addrRows.map(r => r.address));
  },
};

function buildFromCache(rows: { asset_id: string; balance_raw: string; updated_at: number }[]): TronWalletBalances {
  let totalTrx = 0n;
  let totalUsdt = 0n;
  let oldestUpdatedAt = Infinity;

  for (const row of rows) {
    if (row.asset_id === 'tron:TRX')  totalTrx  += BigInt(row.balance_raw);
    if (row.asset_id === 'tron:USDT') totalUsdt += BigInt(row.balance_raw);
    if (row.updated_at < oldestUpdatedAt) oldestUpdatedAt = row.updated_at;
  }

  const cacheUpdatedAt = isFinite(oldestUpdatedAt) ? oldestUpdatedAt : null;
  const stale = cacheUpdatedAt !== null && (Date.now() - cacheUpdatedAt) > STALE_THRESHOLD_MS;

  return {
    trxSun:        totalTrx.toString(),
    usdtSun:       totalUsdt.toString(),
    stale,
    cacheUpdatedAt,
  };
}

async function liveRpcFallback(addresses: string[]): Promise<TronWalletBalances> {
  const adapter = adapterRegistry.get('tron') as TronAdapter;
  const usdtContractAddress = config.TRON_USDT_CONTRACT_ADDRESS ?? '';

  let totalTrx = '0';
  let totalUsdt = '0';

  for (const address of addresses) {
    try {
      const bal = await adapter.getAccountBalance(address, usdtContractAddress);
      totalTrx  = addSatoshi(totalTrx,  bal.trxSun);
      totalUsdt = addSatoshi(totalUsdt, bal.usdtSun);
    } catch {
      // skip failed addresses
    }
  }

  return { trxSun: totalTrx, usdtSun: totalUsdt, stale: false, cacheUpdatedAt: null };
}
