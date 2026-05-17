import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { adapterRegistry } from '../../chain-adapters/registry';
import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import { satoshiToBtc } from '../../shared/money/index';

export const utxosRouter = Router({ mergeParams: true });
export const walletUtxosRouter = Router({ mergeParams: true });

const utxoQuerySchema = z.object({
  minConfirmations: z.coerce.number().int().min(0).optional().default(0),
  includeMempool: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
});

// GET /v1/chains/bitcoin/addresses/:address/utxos
utxosRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const address = req.params['address']!;
    const query = utxoQuerySchema.parse(req.query);
    const adapter = adapterRegistry.get('bitcoin');
    const utxos = await adapter.getUtxosForAddress(address, query.minConfirmations, req.tenantId!);

    res.json({
      data: utxos.map((u) => ({
        ...u,
        amount_display: satoshiToBtc(u.amount),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/wallets/:walletId/utxos
walletUtxosRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const walletId = req.params['walletId']!;
    const query = utxoQuerySchema.parse(req.query);
    const db = getDb();

    const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    const addresses = db
      .prepare("SELECT address FROM addresses WHERE wallet_id = ? AND chain_id = 'bitcoin' AND status = 'active'")
      .all(walletId) as { address: string }[];

    const adapter = adapterRegistry.get('bitcoin');
    const allUtxos: any[] = [];

    for (const { address } of addresses) {
      try {
        const utxos = await adapter.getUtxosForAddress(address, query.minConfirmations, req.tenantId!);
        allUtxos.push(...utxos.map((u) => ({
          ...u,
          amount_display: satoshiToBtc(u.amount),
        })));
      } catch {
        // Skip failed addresses
      }
    }

    res.json({ data: allUtxos });
  } catch (err) {
    next(err);
  }
});
