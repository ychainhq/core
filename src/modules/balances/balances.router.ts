import { Router, Request, Response, NextFunction } from 'express';
import { adapterRegistry } from '../../chain-adapters/registry';
import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import { satoshiToBtc, addSatoshi } from '../../shared/money/index';

export const balancesRouter = Router({ mergeParams: true });
export const walletBalancesRouter = Router({ mergeParams: true });

// GET /v1/chains/:chain/addresses/:address/balances
balancesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { chain, address } = req.params as { chain: string; address: string };
    const adapter = adapterRegistry.get(chain);
    const balance = await adapter.getAddressBalance(address, req.tenantId!);

    res.json({
      data: {
        address,
        chain,
        confirmed: balance.confirmed,
        confirmed_display: satoshiToBtc(balance.confirmed),
        unconfirmed: balance.unconfirmed,
        unconfirmed_display: satoshiToBtc(balance.unconfirmed),
        total: balance.total,
        total_display: satoshiToBtc(balance.total),
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
    const adapter = adapterRegistry.get(chain);

    // Verify asset exists
    const db = getDb();
    const assetRow = db.prepare('SELECT * FROM assets WHERE id = ? OR symbol = ?').get(`${chain}:${asset}`, asset);
    if (!assetRow) throw new NotFoundError('Asset', asset);

    const balance = await adapter.getAddressBalance(address, req.tenantId!);

    res.json({
      data: {
        address,
        chain,
        asset,
        confirmed: balance.confirmed,
        confirmed_display: satoshiToBtc(balance.confirmed),
        unconfirmed: balance.unconfirmed,
        unconfirmed_display: satoshiToBtc(balance.unconfirmed),
        total: balance.total,
        total_display: satoshiToBtc(balance.total),
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
    const db = getDb();

    const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    const addresses = db
      .prepare('SELECT * FROM addresses WHERE wallet_id = ? AND status = ?')
      .all(walletId, 'active') as { chain_id: string; address: string }[];

    // Group by chain
    const chainGroups = new Map<string, string[]>();
    for (const addr of addresses) {
      if (!chainGroups.has(addr.chain_id)) chainGroups.set(addr.chain_id, []);
      chainGroups.get(addr.chain_id)!.push(addr.address);
    }

    const balances: Record<string, {
      confirmed: string;
      unconfirmed: string;
      total: string;
      confirmed_display: string;
      unconfirmed_display: string;
      total_display: string;
    }> = {};

    for (const [chain, addrs] of chainGroups.entries()) {
      const adapter = adapterRegistry.get(chain);
      let totalConfirmed = '0';
      let totalUnconfirmed = '0';

      for (const addr of addrs) {
        try {
          const bal = await adapter.getAddressBalance(addr, req.tenantId!);
          totalConfirmed = addSatoshi(totalConfirmed, bal.confirmed);
          totalUnconfirmed = addSatoshi(totalUnconfirmed, bal.unconfirmed);
        } catch {
          // Skip failed addresses
        }
      }

      const total = addSatoshi(totalConfirmed, totalUnconfirmed);
      balances[chain] = {
        confirmed: totalConfirmed,
        unconfirmed: totalUnconfirmed,
        total,
        confirmed_display: satoshiToBtc(totalConfirmed),
        unconfirmed_display: satoshiToBtc(totalUnconfirmed),
        total_display: satoshiToBtc(total),
      };
    }

    res.json({ data: { walletId, balances } });
  } catch (err) {
    next(err);
  }
});
