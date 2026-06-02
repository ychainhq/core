import { getDbClient } from '../../db/client';
import { NotFoundError } from '../../shared/errors/index';

export interface ChainSpecs {
  finality_type: 'confirmations' | 'safe_finalized';
  evm_chain_id?: number;
}

export interface Chain {
  id: string;
  name: string;
  type: string;
  native_asset: string;
  specs: ChainSpecs | null;
  is_enabled: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapChain(row: any): Chain {
  return {
    ...row,
    is_enabled: row.is_enabled === 1,
    specs: row.specs ? JSON.parse(row.specs) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export const chainsService = {
  async list(filters: { enabled?: boolean; type?: string } = {}): Promise<Chain[]> {
    const db = getDbClient();
    let query = 'SELECT * FROM chains WHERE 1=1';
    const params: unknown[] = [];

    if (filters.enabled !== undefined) {
      query += ' AND is_enabled = ?';
      params.push(filters.enabled ? 1 : 0);
    }
    if (filters.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }
    query += ' ORDER BY id';

    const rows = await db.all(query, params);
    return rows.map(mapChain);
  },

  async getById(id: string): Promise<Chain> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM chains WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Chain', id);
    return mapChain(row);
  },
};
