import { Router, Request, Response, NextFunction } from 'express';
import { getDbClient } from '../../db/client';
import { NotFoundError } from '../../shared/errors/index';
import { satoshiToBtc, addSatoshi } from '../../shared/money/index';
import { utxoLockService } from '../../shared/utxo-lock/utxo-lock.service';

export const balancesRouter = Router({ mergeParams: true });
export const walletBalancesRouter = Router({ mergeParams: true });

// GET /v1/chains/:chain/addresses/:address/balances
balancesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chain, address } = req.params as { chain: string; address: string };
    const bal = await utxoLockService.getAddressBalance(req.tenantId!, chain, address);
    res.json({
      data: {
        address, chain,
        confirmed:           bal.confirmed,
        confirmed_display:   satoshiToBtc(bal.confirmed),
        unconfirmed:         bal.unconfirmed,
        unconfirmed_display: satoshiToBtc(bal.unconfirmed),
        total:               bal.total,
        total_display:       satoshiToBtc(bal.total),
        asset: `${chain}:${chain === 'bitcoin' ? 'BTC' : 'ETH'}`,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/chains/:chain/addresses/:address/balances/:asset
balancesRouter.get('/:asset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chain, address, asset } = req.params as { chain: string; address: string; asset: string };
    const db = getDbClient();
    const assetRow = await db.get(
      'SELECT * FROM assets WHERE chain_id = ? AND (id = ? OR symbol = ?)',
      [chain, `${chain}:${asset}`, asset]
    );
    if (!assetRow) throw new NotFoundError('Asset', asset);

    const bal = await utxoLockService.getAddressBalance(req.tenantId!, chain, address);
    res.json({
      data: {
        address, chain, asset,
        confirmed:           bal.confirmed,
        confirmed_display:   satoshiToBtc(bal.confirmed),
        unconfirmed:         bal.unconfirmed,
        unconfirmed_display: satoshiToBtc(bal.unconfirmed),
        total:               bal.total,
        total_display:       satoshiToBtc(bal.total),
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
    const db = getDbClient();

    const wallet = await db.get('SELECT * FROM wallets WHERE id = ?', [walletId]);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    const chainBalances = await utxoLockService.getWalletBalances(walletId);

    // Ensure chains with addresses but no UTXOs appear in the response
    const chainIds = await db.all<{ chain_id: string }>(
      'SELECT DISTINCT chain_id FROM addresses WHERE wallet_id = ? AND status = ?', [walletId, 'active']
    );
    for (const { chain_id } of chainIds) {
      if (!chainBalances[chain_id]) {
        chainBalances[chain_id] = { confirmed: '0', unconfirmed: '0', total: '0' };
      }
    }

    const balances: Record<string, object> = {};
    for (const [chain, b] of Object.entries(chainBalances)) {
      balances[chain] = {
        confirmed:           b.confirmed,
        confirmed_display:   satoshiToBtc(b.confirmed),
        unconfirmed:         b.unconfirmed,
        unconfirmed_display: satoshiToBtc(b.unconfirmed),
        total:               b.total,
        total_display:       satoshiToBtc(b.total),
      };
    }

    res.json({ data: { walletId, balances } });
  } catch (err) {
    next(err);
  }
});
