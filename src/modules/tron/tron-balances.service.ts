import { getDbClient } from '../../db/client';
import { adapterRegistry } from '../../chain-adapters/registry';
import { TronAdapter } from '../../chain-adapters/tron/adapter';
import { addSatoshi } from '../../shared/money/index';
import { config } from '../../config/index';

export interface TronWalletBalances {
  trxSun: string;
  usdtSun: string;
}

export const tronBalancesService = {
  async getWalletBalances(walletId: string): Promise<TronWalletBalances> {
    const db = getDbClient();
    const adapter = adapterRegistry.get('tron') as TronAdapter;
    const usdtContractAddress = config.TRON_USDT_CONTRACT_ADDRESS ?? '';

    const addresses = await db.all<{ address: string }>(
      "SELECT address FROM addresses WHERE wallet_id = ? AND chain_id = 'tron' AND status = 'active'",
      [walletId],
    );

    if (addresses.length === 0) {
      return { trxSun: '0', usdtSun: '0' };
    }

    let totalTrx = '0';
    let totalUsdt = '0';

    for (const { address } of addresses) {
      try {
        const bal = await adapter.getAccountBalance(address, usdtContractAddress);
        totalTrx = addSatoshi(totalTrx, bal.trxSun);
        totalUsdt = addSatoshi(totalUsdt, bal.usdtSun);
      } catch {
        // skip failed addresses — same pattern as Bitcoin balance handling
      }
    }

    return { trxSun: totalTrx, usdtSun: totalUsdt };
  },
};
