/**
 * UTXO Lock Service
 *
 * Provides atomic TTL-based UTXO reservation for batch building.
 * Prevents two batches from using the same UTXO.
 *
 * Design:
 * - SELECT unlocked UTXOs → attempt UPDATE is_locked=1 inside a transaction
 * - If UPDATE changes=0 the UTXO was concurrently locked → retry coin selection
 * - utxo_locks table tracks locks for audit/cleanup
 */

import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { logger } from '../logging/index';

export interface UtxoLock {
  id: string;
  tenant_id: string;
  batch_id: string;
  chain_id: string;
  tx_hash: string;
  vout: number;
  amount_raw: string;
  status: string;
  locked_at: string;
  expires_at: string;
  released_at: string | null;
}

export interface UtxoCandidate {
  tx_hash: string;
  vout: number;
  amount_raw: string;
  chain_id: string;
  tenant_id: string;
}

const LOCK_TTL_SECONDS = parseInt(process.env['UTXO_LOCK_TTL_SECONDS'] ?? '900', 10); // 15 minutes

export const utxoLockService = {
  /**
   * Select available UTXOs and lock them atomically for a batch.
   * Returns the locked UTXOs or throws if locking fails.
   *
   * Uses SQLite's BEGIN IMMEDIATE transaction to serialize concurrent access.
   * If any UTXO cannot be locked (changes=0), all locks are rolled back.
   */
  lockUtxosForBatch(
    tenantId: string,
    batchId: string,
    chainId: string,
    minConfirmations: number,
    targetAmountRaw: string,
    feeBufferRaw: string
  ): UtxoCandidate[] {
    const db = getDb();
    const targetAmount = BigInt(targetAmountRaw);
    const feeBuffer = BigInt(feeBufferRaw);
    const needed = targetAmount + feeBuffer;

    // Begin exclusive transaction for coin selection + locking
    const lockUtxos = db.transaction((): UtxoCandidate[] => {
      // Select available UTXOs
      const candidates = db.prepare(`
        SELECT tx_hash, vout, amount_raw, chain_id, tenant_id
        FROM cached_utxos
        WHERE tenant_id = ?
          AND chain_id = ?
          AND wallet_role = 'tenant_hot'
          AND is_spent = 0
          AND is_locked = 0
          AND confirmations >= ?
        ORDER BY CAST(amount_raw AS INTEGER) ASC
      `).all(tenantId, chainId, minConfirmations) as UtxoCandidate[];

      if (candidates.length === 0) {
        throw new Error('No available UTXOs for coin selection');
      }

      // Greedy coin selection
      const selected: UtxoCandidate[] = [];
      let accumulated = BigInt(0);

      for (const utxo of candidates) {
        selected.push(utxo);
        accumulated += BigInt(utxo.amount_raw);
        if (accumulated >= needed) break;
      }

      if (accumulated < needed) {
        throw new Error(
          `Insufficient UTXO balance: have ${accumulated} sats, need ${needed} sats (target ${targetAmountRaw} + fee buffer ${feeBufferRaw})`
        );
      }

      // Atomically lock each selected UTXO
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000).toISOString();

      for (const utxo of selected) {
        const result = db.prepare(`
          UPDATE cached_utxos
          SET is_locked = 1
          WHERE tenant_id = ?
            AND chain_id = ?
            AND tx_hash = ?
            AND vout = ?
            AND is_locked = 0
            AND is_spent = 0
        `).run(tenantId, chainId, utxo.tx_hash, utxo.vout);

        if (result.changes === 0) {
          // UTXO was concurrently locked — abort
          throw new Error(
            `UTXO ${utxo.tx_hash}:${utxo.vout} was locked concurrently — retry coin selection`
          );
        }

        // Record the lock in utxo_locks for audit/cleanup
        const lockId = `ulk_${crypto.randomBytes(8).toString('hex')}`;
        db.prepare(`
          INSERT INTO utxo_locks (id, tenant_id, batch_id, chain_id, tx_hash, vout, amount_raw,
                                  status, locked_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'locked', ?, ?)
          ON CONFLICT(chain_id, tx_hash, vout) DO UPDATE SET
            status = 'locked',
            batch_id = excluded.batch_id,
            locked_at = excluded.locked_at,
            expires_at = excluded.expires_at,
            released_at = NULL
        `).run(lockId, tenantId, batchId, chainId, utxo.tx_hash, utxo.vout, utxo.amount_raw, now, expiresAt);
      }

      logger.debug('UTXOs locked for batch', {
        tenantId, batchId, count: selected.length, total: accumulated.toString()
      });

      return selected;
    });

    return lockUtxos();
  },

  /**
   * Release all UTXO locks for a batch.
   * Called when batch is cancelled, failed, or replaced.
   */
  releaseLocksForBatch(tenantId: string, batchId: string): void {
    const db = getDb();

    db.transaction(() => {
      // Get locked UTXOs for this batch
      const locks = db.prepare(`
        SELECT chain_id, tx_hash, vout
        FROM utxo_locks
        WHERE tenant_id = ? AND batch_id = ? AND status = 'locked'
      `).all(tenantId, batchId) as Array<{ chain_id: string; tx_hash: string; vout: number }>;

      const now = new Date().toISOString();

      for (const lock of locks) {
        // Release the cached_utxos lock flag
        db.prepare(`
          UPDATE cached_utxos
          SET is_locked = 0
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `).run(tenantId, lock.chain_id, lock.tx_hash, lock.vout);

        // Mark lock record as released
        db.prepare(`
          UPDATE utxo_locks
          SET status = 'released', released_at = ?
          WHERE tenant_id = ? AND batch_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `).run(now, tenantId, batchId, lock.chain_id, lock.tx_hash, lock.vout);
      }

      logger.debug('UTXO locks released for batch', { tenantId, batchId, count: locks.length });
    })();
  },

  /**
   * Mark UTXOs as spent when a batch is broadcast.
   */
  markSpentForBatch(tenantId: string, batchId: string): void {
    const db = getDb();

    db.transaction(() => {
      const locks = db.prepare(`
        SELECT chain_id, tx_hash, vout
        FROM utxo_locks
        WHERE tenant_id = ? AND batch_id = ? AND status = 'locked'
      `).all(tenantId, batchId) as Array<{ chain_id: string; tx_hash: string; vout: number }>;

      for (const lock of locks) {
        db.prepare(`
          UPDATE cached_utxos
          SET is_locked = 0, is_spent = 1
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `).run(tenantId, lock.chain_id, lock.tx_hash, lock.vout);

        db.prepare(`
          UPDATE utxo_locks
          SET status = 'spent'
          WHERE tenant_id = ? AND batch_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `).run(tenantId, batchId, lock.chain_id, lock.tx_hash, lock.vout);
      }

      logger.debug('UTXOs marked as spent for batch', { tenantId, batchId, count: locks.length });
    })();
  },

  /**
   * Cleanup expired UTXO locks.
   * Called by the signing task expiry worker.
   */
  cleanupExpiredLocks(): number {
    const db = getDb();
    const now = new Date().toISOString();

    const result = db.transaction(() => {
      // Find expired locks
      const expired = db.prepare(`
        SELECT tenant_id, batch_id, chain_id, tx_hash, vout
        FROM utxo_locks
        WHERE status = 'locked' AND expires_at < ?
      `).all(now) as Array<{ tenant_id: string; batch_id: string; chain_id: string; tx_hash: string; vout: number }>;

      for (const lock of expired) {
        db.prepare(`
          UPDATE cached_utxos
          SET is_locked = 0
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `).run(lock.tenant_id, lock.chain_id, lock.tx_hash, lock.vout);

        db.prepare(`
          UPDATE utxo_locks
          SET status = 'released', released_at = ?
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
            AND status = 'locked'
        `).run(now, lock.tenant_id, lock.chain_id, lock.tx_hash, lock.vout);
      }

      return expired.length;
    })();

    if (result > 0) {
      logger.info('Expired UTXO locks cleaned up', { count: result });
    }

    return result;
  },
};
