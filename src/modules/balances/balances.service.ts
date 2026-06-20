import { adapterRegistry } from '../../chain-adapters/registry';
import { getDbClient } from '../../db/client';
import { NotFoundError } from '../../shared/errors/index';
import { formatAssetDisplay } from '../../shared/money/index';
import { utxoLockService } from '../../shared/utxo-lock/utxo-lock.service';
import { tronBalancesService } from '../tron/tron-balances.service';
import { TronAdapter } from '../../chain-adapters/tron/adapter';
import { config } from '../../config/index';

export const balancesService = {
  async getAddressBalance(tenantId: string, chain: string, address: string, asset?: string): Promise<Record<string, unknown>> {
    if (chain === 'tron') {
      if (!asset || asset === 'tron:TRX' || asset === 'TRX') {
        const bal = await adapterRegistry.get('tron').getAddressBalance(address, tenantId);
        return {
          address, chain,
          asset:               'tron:TRX',
          confirmed:           bal.confirmed,
          confirmed_display:   formatAssetDisplay(bal.confirmed, 6, 'TRX'),
          unconfirmed:         bal.unconfirmed,
          unconfirmed_display: formatAssetDisplay(bal.unconfirmed, 6, 'TRX'),
          total:               bal.total,
          total_display:       formatAssetDisplay(bal.total, 6, 'TRX'),
        };
      }
      if (asset === 'tron:USDT' || asset === 'USDT') {
        const contractAddress = config.TRON_USDT_CONTRACT_ADDRESS ?? '';
        const tronAdapter = adapterRegistry.get('tron') as TronAdapter;
        const total = await tronAdapter.getTrc20Balance(address, contractAddress);
        return {
          address, chain,
          asset:               'tron:USDT',
          confirmed:           total,
          confirmed_display:   formatAssetDisplay(total, 6, 'USDT'),
          unconfirmed:         '0',
          unconfirmed_display: formatAssetDisplay('0', 6, 'USDT'),
          total,
          total_display:       formatAssetDisplay(total, 6, 'USDT'),
        };
      }
    }
    const bal = await utxoLockService.getAddressBalance(tenantId, chain, address);
    return {
      address, chain,
      asset:               asset ?? 'bitcoin:BTC',
      confirmed:           bal.confirmed,
      confirmed_display:   formatAssetDisplay(bal.confirmed, 8, 'BTC'),
      unconfirmed:         bal.unconfirmed,
      unconfirmed_display: formatAssetDisplay(bal.unconfirmed, 8, 'BTC'),
      total:               bal.total,
      total_display:       formatAssetDisplay(bal.total, 8, 'BTC'),
    };
  },

  async getWalletBalances(tenantId: string, walletId: string): Promise<Record<string, unknown>> {
    const db = getDbClient();
    const wallet = await db.get('SELECT id FROM wallets WHERE id = ? AND tenant_id = ?', [walletId, tenantId]);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    const chainIds = await db.all<{ chain_id: string }>(
      'SELECT DISTINCT chain_id FROM addresses WHERE wallet_id = ? AND status = ?', [walletId, 'active'],
    );

    const balances: Record<string, Record<string, unknown>> = {};

    for (const { chain_id } of chainIds) {
      if (chain_id === 'bitcoin') {
        const chainBalances = await utxoLockService.getWalletBalances(walletId);
        const b = chainBalances['bitcoin'] ?? { confirmed: '0', unconfirmed: '0', total: '0' };
        balances['bitcoin:BTC'] = {
          confirmed:           b.confirmed,
          confirmed_display:   formatAssetDisplay(b.confirmed, 8, 'BTC'),
          unconfirmed:         b.unconfirmed,
          unconfirmed_display: formatAssetDisplay(b.unconfirmed, 8, 'BTC'),
          total:               b.total,
          total_display:       formatAssetDisplay(b.total, 8, 'BTC'),
        };
      } else if (chain_id === 'tron') {
        const tron = await tronBalancesService.getWalletBalances(walletId);
        balances['tron:TRX'] = {
          confirmed:           tron.trxSun,
          confirmed_display:   formatAssetDisplay(tron.trxSun, 6, 'TRX'),
          unconfirmed:         '0',
          unconfirmed_display: formatAssetDisplay('0', 6, 'TRX'),
          total:               tron.trxSun,
          total_display:       formatAssetDisplay(tron.trxSun, 6, 'TRX'),
          stale:               tron.stale,
          cache_updated_at:    tron.cacheUpdatedAt,
        };
        balances['tron:USDT'] = {
          confirmed:           tron.usdtSun,
          confirmed_display:   formatAssetDisplay(tron.usdtSun, 6, 'USDT'),
          unconfirmed:         '0',
          unconfirmed_display: formatAssetDisplay('0', 6, 'USDT'),
          total:               tron.usdtSun,
          total_display:       formatAssetDisplay(tron.usdtSun, 6, 'USDT'),
          stale:               tron.stale,
          cache_updated_at:    tron.cacheUpdatedAt,
        };
      }
    }

    return { walletId, balances };
  },
};
