import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';

export interface AssetSpecs {
  contract_address?: string;  // present for type=token (ERC-20 etc.)
}

export interface Asset {
  id: string;
  chain_id: string;
  symbol: string;
  name: string;
  type: string;
  decimals: number;
  specs: AssetSpecs | null;
  is_enabled: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapAsset(row: any): Asset {
  return {
    ...row,
    is_enabled: row.is_enabled === 1,
    specs: row.specs ? JSON.parse(row.specs) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export const assetsService = {
  list(filters: { chain?: string; type?: string } = {}): Asset[] {
    const db = getDb();
    let query = 'SELECT * FROM assets WHERE 1=1';
    const params: unknown[] = [];

    if (filters.chain) {
      query += ' AND chain_id = ?';
      params.push(filters.chain);
    }
    if (filters.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }
    query += ' ORDER BY id';

    const rows = db.prepare(query).all(...params);
    return rows.map(mapAsset);
  },

  getByChainAndSymbol(chainId: string, symbol: string): Asset {
    const db = getDb();
    // Try by ID first (e.g. 'bitcoin:BTC')
    const assetId = `${chainId}:${symbol}`;
    let row = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!row) {
      row = db
        .prepare('SELECT * FROM assets WHERE chain_id = ? AND symbol = ?')
        .get(chainId, symbol);
    }
    if (!row) throw new NotFoundError('Asset', `${chainId}/${symbol}`);
    return mapAsset(row);
  },

  getById(id: string): Asset {
    const db = getDb();
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Asset', id);
    return mapAsset(row);
  },
};
