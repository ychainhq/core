import { Router, Request, Response, NextFunction } from 'express';
import { getDbClient } from '../../db/client';
import { NotFoundError } from '../../shared/errors/index';
import { formatAssetDisplay } from '../../shared/money/index';
import { utxoLockService } from '../../shared/utxo-lock/utxo-lock.service';
import { adapterRegistry } from '../../chain-adapters/registry';
import { TronAdapter } from '../../chain-adapters/tron/adapter';
import { config } from '../../config/index';
import { logger } from '../../shared/logging/index';
import { balancesService } from './balances.service';

export const balancesRouter = Router({ mergeParams: true });
export const walletBalancesRouter = Router({ mergeParams: true });

// GET /v1/chains/:chain/addresses/:address/balances
balancesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chain, address } = req.params as { chain: string; address: string };
    res.json({ data: await balancesService.getAddressBalance(req.tenantId!, chain, address) });
  } catch (err) {
    next(err);
  }
});

// GET /v1/chains/:chain/addresses/:address/balances/:asset
balancesRouter.get('/:asset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chain, address, asset } = req.params as { chain: string; address: string; asset: string };
    const db = getDbClient();
    const assetRow = await db.get<{ id: string; decimals: number; symbol: string; specs: string | null }>(
      'SELECT * FROM assets WHERE chain_id = ? AND (id = ? OR symbol = ?)',
      [chain, `${chain}:${asset}`, asset],
    );
    if (!assetRow) throw new NotFoundError('Asset', asset);

    if (chain === 'tron') {
      const assetId = assetRow.id;
      if (assetId === 'tron:USDT') {
        const specs = assetRow.specs
          ? (typeof assetRow.specs === 'string' ? JSON.parse(assetRow.specs) : assetRow.specs)
          : {};
        const contractAddress: string = specs?.contract_address ?? config.TRON_USDT_CONTRACT_ADDRESS ?? '';
        const adapter = adapterRegistry.get('tron') as TronAdapter;
        const total = await adapter.getTrc20Balance(address, contractAddress);
        res.json({
          data: {
            address, chain,
            asset:               'tron:USDT',
            confirmed:           total,
            confirmed_display:   formatAssetDisplay(total, 6, 'USDT'),
            unconfirmed:         '0',
            unconfirmed_display: formatAssetDisplay('0', 6, 'USDT'),
            total,
            total_display:       formatAssetDisplay(total, 6, 'USDT'),
          },
        });
        return;
      }
      // tron:TRX
      const bal = await adapterRegistry.get('tron').getAddressBalance(address, req.tenantId!);
      res.json({
        data: {
          address, chain,
          asset:               'tron:TRX',
          confirmed:           bal.confirmed,
          confirmed_display:   formatAssetDisplay(bal.confirmed, 6, 'TRX'),
          unconfirmed:         bal.unconfirmed,
          unconfirmed_display: formatAssetDisplay(bal.unconfirmed, 6, 'TRX'),
          total:               bal.total,
          total_display:       formatAssetDisplay(bal.total, 6, 'TRX'),
        },
      });
      return;
    }

    const bal = await utxoLockService.getAddressBalance(req.tenantId!, chain, address);
    res.json({
      data: {
        address, chain,
        asset,
        confirmed:           bal.confirmed,
        confirmed_display:   formatAssetDisplay(bal.confirmed, 8, 'BTC'),
        unconfirmed:         bal.unconfirmed,
        unconfirmed_display: formatAssetDisplay(bal.unconfirmed, 8, 'BTC'),
        total:               bal.total,
        total_display:       formatAssetDisplay(bal.total, 8, 'BTC'),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/wallets/:walletId/balances
walletBalancesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const walletId = req.params['walletId']!;
    res.json({ data: await balancesService.getWalletBalances(req.tenantId!, walletId) });
  } catch (err) {
    next(err);
  }
});

// POST /v1/chains/tron/addresses/:address/balance-refresh
// Triggers an async balance cache refresh for a single TRON address. Returns 202 immediately.
export const tronAddressBalanceRefreshRouter = Router({ mergeParams: true });

tronAddressBalanceRefreshRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = req.params as { address: string };
    const usdtContractAddress = config.TRON_USDT_CONTRACT_ADDRESS ?? '';

    const adapter = adapterRegistry.get('tron') as TronAdapter;
    const db = getDbClient();

    setImmediate(async () => {
      try {
        const bal = await adapter.getAccountBalance(address, usdtContractAddress);
        const now = Date.now();
        const upsertSql = `
          INSERT INTO tron_account_balances (address, asset_id, balance_raw, block_number, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (address, asset_id) DO UPDATE SET
            balance_raw  = excluded.balance_raw,
            block_number = excluded.block_number,
            updated_at   = excluded.updated_at
        `;
        await db.run(upsertSql, [address, 'tron:TRX',  bal.trxSun,  0, now]);
        await db.run(upsertSql, [address, 'tron:USDT', bal.usdtSun, 0, now]);
      } catch (err) {
        logger.warn('balance-refresh: failed to refresh TRON address', { address, error: String(err) });
      }
    });

    res.status(202).json({ data: { address, status: 'refresh_queued' } });
  } catch (err) {
    next(err);
  }
});
