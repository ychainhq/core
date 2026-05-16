import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';

export interface Chain {
  id: string;
  name: string;
  type: string;
  native_asset: string;
  chain_id: number | null;
  finality_type: string;
  is_enabled: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapChain(row: any): Chain {
  return {
    ...row,
    is_enabled: row.is_enabled === 1,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export const chainsService = {
  list(filters: { enabled?: boolean; type?: string } = {}): Chain[] {
    const db = getDb();
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

    const rows = db.prepare(query).all(...params);
    return rows.map(mapChain);
  },

  getById(id: string): Chain {
    const db = getDb();
    const row = db.prepare('SELECT * FROM chains WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Chain', id);
    return mapChain(row);
  },
};
