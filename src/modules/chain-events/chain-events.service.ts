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

const PENDING_TYPES = `event_type IN ('utxo_created', 'utxo_spent')`;

export const chainEventsService = {
  /**
   * Atomically claim and mark a batch of unprocessed events as processed.
   *
   * PostgreSQL: SELECT ... FOR UPDATE SKIP LOCKED + UPDATE run inside a single
   * transaction — two engine instances can never receive the same batch.
   *
   * SQLite (tests / dev): plain SELECT + UPDATE. SQLite is single-process and
   * Node.js is single-threaded, so no concurrent claim is possible.
   */
  async claimAndMarkProcessed(batchSize: number): Promise<ChainEvent[]> {
    const db = getDbClient();
    const now = new Date().toISOString();

    if (!db.isPostgres) {
      const rows = await db.all<ChainEvent>(`
        SELECT * FROM chain_events
        WHERE processed = 0 AND ${PENDING_TYPES}
        ORDER BY created_at ASC
        LIMIT ?
      `, [batchSize]);
      if (rows.length > 0) {
        const ids = rows.map(r => r.id);
        await db.run(`
          UPDATE chain_events SET processed = 1, processed_at = ?
          WHERE id IN (${ids.map(() => '?').join(',')})
        `, [now, ...ids]);
      }
      return rows;
    }

    return db.transaction(async (tx) => {
      const rows = await tx.all<ChainEvent>(`
        SELECT * FROM chain_events
        WHERE processed = 0 AND ${PENDING_TYPES}
        ORDER BY created_at ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED
      `, [batchSize]);
      if (rows.length === 0) return [];
      const ids = rows.map(r => r.id);
      await tx.run(`
        UPDATE chain_events SET processed = 1, processed_at = ?
        WHERE id IN (${ids.map(() => '?').join(',')})
      `, [now, ...ids]);
      return rows;
    });
  },

  async fetchUnprocessed(batchSize: number): Promise<ChainEvent[]> {
    const db = getDbClient();
    return db.all<ChainEvent>(`
      SELECT * FROM chain_events
      WHERE processed = 0 AND ${PENDING_TYPES}
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
