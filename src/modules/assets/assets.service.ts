import { getDbClient } from '../../db/client';
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
  async list(filters: { chain?: string; type?: string } = {}): Promise<Asset[]> {
    const db = getDbClient();
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

    const rows = await db.all(query, params);
    return rows.map(mapAsset);
  },

  async getByChainAndSymbol(chainId: string, symbol: string): Promise<Asset> {
    const db = getDbClient();
    // Try by ID first (e.g. 'bitcoin:BTC')
    const assetId = `${chainId}:${symbol}`;
    let row = await db.get('SELECT * FROM assets WHERE id = ?', [assetId]);
    if (!row) {
      row = await db.get(
        'SELECT * FROM assets WHERE chain_id = ? AND symbol = ?',
        [chainId, symbol]
      );
    }
    if (!row) throw new NotFoundError('Asset', `${chainId}/${symbol}`);
    return mapAsset(row);
  },

  async getById(id: string): Promise<Asset> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM assets WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Asset', id);
    return mapAsset(row);
  },
};
