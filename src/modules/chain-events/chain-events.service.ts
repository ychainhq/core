import { getDbClient } from '../../db/client';

export interface ChainEvent {
  id: string;
  chain_id: string;
  node_id: string;
  event_type: string;
  tx_hash: string;
  vout_index: number | null;
  spent_tx_hash: string | null;
  spent_vout: number | null;
  address: string | null;
  amount_raw: string | null;
  block_height: number | null;
  block_hash: string | null;
  confirmations: number;
  created_at: string;
}

export const chainEventsService = {
  async fetchUnprocessed(batchSize: number): Promise<ChainEvent[]> {
    const db = getDbClient();
    return db.all<ChainEvent>(`
      SELECT * FROM chain_events
      WHERE processed = 0
        AND event_type IN ('utxo_created', 'utxo_spent')
      ORDER BY created_at ASC
      LIMIT ?
    `, [batchSize]);
  },

  async markProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = getDbClient();
    await db.run(`
      UPDATE chain_events
      SET processed = 1, processed_at = ?
      WHERE id IN (${ids.map(() => '?').join(',')})
    `, [new Date().toISOString(), ...ids]);
  },
};
