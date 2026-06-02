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
import { getDbClient } from '../../db/client';
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
  async lockUtxosForBatch(
    tenantId: string,
    batchId: string,
    chainId: string,
    minConfirmations: number,
    targetAmountRaw: string,
    feeBufferRaw: string
  ): Promise<UtxoCandidate[]> {
    const db = getDbClient();
    const targetAmount = BigInt(targetAmountRaw);
    const feeBuffer = BigInt(feeBufferRaw);
    const needed = targetAmount + feeBuffer;

    return await db.transaction(async (tx): Promise<UtxoCandidate[]> => {
      // Select available UTXOs
      const candidates = await tx.all<UtxoCandidate>(`
        SELECT tx_hash, vout, amount_raw, chain_id, tenant_id
        FROM cached_utxos
        WHERE tenant_id = ?
          AND chain_id = ?
          AND wallet_role = 'tenant_hot'
          AND is_spent = 0
          AND is_locked = 0
          AND confirmations >= ?
        ORDER BY CAST(amount_raw AS INTEGER) ASC
      `, [tenantId, chainId, minConfirmations]);

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
        const result = await tx.run(`
          UPDATE cached_utxos
          SET is_locked = 1
          WHERE tenant_id = ?
            AND chain_id = ?
            AND tx_hash = ?
            AND vout = ?
            AND is_locked = 0
            AND is_spent = 0
        `, [tenantId, chainId, utxo.tx_hash, utxo.vout]);

        if (result.changes === 0) {
          // UTXO was concurrently locked — abort
          throw new Error(
            `UTXO ${utxo.tx_hash}:${utxo.vout} was locked concurrently — retry coin selection`
          );
        }

        // Record the lock in utxo_locks for audit/cleanup
        const lockId = `ulk_${crypto.randomBytes(8).toString('hex')}`;
        await tx.run(`
          INSERT INTO utxo_locks (id, tenant_id, batch_id, chain_id, tx_hash, vout, amount_raw,
                                  status, locked_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'locked', ?, ?)
          ON CONFLICT(chain_id, tx_hash, vout) DO UPDATE SET
            status = 'locked',
            batch_id = excluded.batch_id,
            locked_at = excluded.locked_at,
            expires_at = excluded.expires_at,
            released_at = NULL
        `, [lockId, tenantId, batchId, chainId, utxo.tx_hash, utxo.vout, utxo.amount_raw, now, expiresAt]);
      }

      logger.debug('UTXOs locked for batch', {
        tenantId, batchId, count: selected.length, total: accumulated.toString()
      });

      return selected;
    });
  },

  /**
   * Release all UTXO locks for a batch.
   * Called when batch is cancelled, failed, or replaced.
   */
  async releaseLocksForBatch(tenantId: string, batchId: string): Promise<void> {
    const db = getDbClient();

    await db.transaction(async (tx) => {
      // Get locked UTXOs for this batch
      const locks = await tx.all<{ chain_id: string; tx_hash: string; vout: number }>(`
        SELECT chain_id, tx_hash, vout
        FROM utxo_locks
        WHERE tenant_id = ? AND batch_id = ? AND status = 'locked'
      `, [tenantId, batchId]);

      const now = new Date().toISOString();

      for (const lock of locks) {
        // Release the cached_utxos lock flag
        await tx.run(`
          UPDATE cached_utxos
          SET is_locked = 0
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [tenantId, lock.chain_id, lock.tx_hash, lock.vout]);

        // Mark lock record as released
        await tx.run(`
          UPDATE utxo_locks
          SET status = 'released', released_at = ?
          WHERE tenant_id = ? AND batch_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [now, tenantId, batchId, lock.chain_id, lock.tx_hash, lock.vout]);
      }

      logger.debug('UTXO locks released for batch', { tenantId, batchId, count: locks.length });
    });
  },

  /**
   * Mark UTXOs as spent when a batch is broadcast.
   */
  async markSpentForBatch(tenantId: string, batchId: string): Promise<void> {
    const db = getDbClient();

    await db.transaction(async (tx) => {
      const locks = await tx.all<{ chain_id: string; tx_hash: string; vout: number }>(`
        SELECT chain_id, tx_hash, vout
        FROM utxo_locks
        WHERE tenant_id = ? AND batch_id = ? AND status = 'locked'
      `, [tenantId, batchId]);

      for (const lock of locks) {
        await tx.run(`
          UPDATE cached_utxos
          SET is_locked = 0, is_spent = 1
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [tenantId, lock.chain_id, lock.tx_hash, lock.vout]);

        await tx.run(`
          UPDATE utxo_locks
          SET status = 'spent'
          WHERE tenant_id = ? AND batch_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [tenantId, batchId, lock.chain_id, lock.tx_hash, lock.vout]);
      }

      logger.debug('UTXOs marked as spent for batch', { tenantId, batchId, count: locks.length });
    });
  },

  /**
   * Lock a single UTXO for a batch atomically.
   * Used by CPFP where a single change UTXO is reserved outside normal coin selection.
   * Returns the generated lock ID.
   * Throws if the UTXO is already locked.
   */
  async lockSingleUtxo(
    tenantId: string,
    batchId: string,
    chainId: string,
    utxo: { tx_hash: string; vout: number; amount_raw: string },
    ttlMs = LOCK_TTL_SECONDS * 1000
  ): Promise<string> {
    const db = getDbClient();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    return await db.transaction(async (tx) => {
      const result = await tx.run(`
        UPDATE cached_utxos
        SET is_locked = 1
        WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
          AND is_locked = 0 AND is_spent = 0
      `, [tenantId, chainId, utxo.tx_hash, utxo.vout]);

      if (result.changes === 0) {
        throw new Error(
          `UTXO ${utxo.tx_hash}:${utxo.vout} was concurrently locked or already spent`
        );
      }

      const lockId = `ulk_${crypto.randomBytes(8).toString('hex')}`;
      await tx.run(`
        INSERT INTO utxo_locks (id, tenant_id, batch_id, chain_id, tx_hash, vout, amount_raw, status, locked_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'locked', ?, ?)
      `, [lockId, tenantId, batchId, chainId, utxo.tx_hash, utxo.vout, utxo.amount_raw, now, expiresAt]);

      logger.debug('Single UTXO locked', { tenantId, batchId, txHash: utxo.tx_hash, vout: utxo.vout });
      return lockId;
    });
  },

  /**
   * Release a single UTXO lock by lock ID.
   * Used by CPFP rollback path.
   */
  async releaseSingleUtxo(
    tenantId: string,
    chainId: string,
    lockId: string,
    utxo: { tx_hash: string; vout: number }
  ): Promise<void> {
    const db = getDbClient();
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      await tx.run(`
        UPDATE cached_utxos SET is_locked = 0
        WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
      `, [tenantId, chainId, utxo.tx_hash, utxo.vout]);

      await tx.run(`
        UPDATE utxo_locks SET status = 'released', released_at = ? WHERE id = ?
      `, [now, lockId]);
    });
  },

  /**
   * Reassign existing locked UTXOs from one batch to another.
   * Used by RBF to transfer lock ownership to the replacement batch.
   */
  async reassignLocks(
    tenantId: string,
    fromBatchId: string,
    toBatchId: string,
    newExpiresAt?: string
  ): Promise<void> {
    const db = getDbClient();
    if (newExpiresAt !== undefined) {
      await db.run(`
        UPDATE utxo_locks SET batch_id = ?, expires_at = ?
        WHERE tenant_id = ? AND batch_id = ? AND status = 'locked'
      `, [toBatchId, newExpiresAt, tenantId, fromBatchId]);
    } else {
      await db.run(`
        UPDATE utxo_locks SET batch_id = ?
        WHERE tenant_id = ? AND batch_id = ? AND status = 'locked'
      `, [toBatchId, tenantId, fromBatchId]);
    }
  },

  /**
   * Cleanup expired UTXO locks.
   * Called by the signing task expiry worker.
   */
  async cleanupExpiredLocks(): Promise<number> {
    const db = getDbClient();
    const now = new Date().toISOString();

    const result = await db.transaction(async (tx) => {
      // Find expired locks
      const expired = await tx.all<{ tenant_id: string; batch_id: string; chain_id: string; tx_hash: string; vout: number }>(`
        SELECT tenant_id, batch_id, chain_id, tx_hash, vout
        FROM utxo_locks
        WHERE status = 'locked' AND expires_at < ?
      `, [now]);

      for (const lock of expired) {
        await tx.run(`
          UPDATE cached_utxos
          SET is_locked = 0
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [lock.tenant_id, lock.chain_id, lock.tx_hash, lock.vout]);

        await tx.run(`
          UPDATE utxo_locks
          SET status = 'released', released_at = ?
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
            AND status = 'locked'
        `, [now, lock.tenant_id, lock.chain_id, lock.tx_hash, lock.vout]);
      }

      return expired.length;
    });

    if (result > 0) {
      logger.info('Expired UTXO locks cleaned up', { count: result });
    }

    return result;
  },
};
