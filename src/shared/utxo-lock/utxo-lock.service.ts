/**
 * UTXO Lock Service
 *
 * Provides atomic TTL-based UTXO reservation for batch building and sweeps.
 * Prevents two operations from using the same UTXO concurrently.
 *
 * Design:
 * - SELECT unlocked UTXOs → attempt UPDATE is_locked=1 inside a transaction
 * - If UPDATE changes=0 the UTXO was concurrently locked → retry coin selection
 * - utxo_locks table tracks locks for audit/cleanup
 *
 * reference_type discriminator:
 *   'batch'  — locked for a withdrawal batch (reference_id = withdrawal_batches.id)
 *   'sweep'  — locked for a sweep          (reference_id = sweeps.id)
 */

import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { logger } from '../logging/index';

export interface UtxoLock {
  id: string;
  tenant_id: string;
  reference_id: string;    // was: batch_id
  reference_type: string;  // 'batch' | 'sweep'
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

// Withdrawal batch locks expire after 15 min (safety net for abandoned batches).
const LOCK_TTL_SECONDS = parseInt(process.env['UTXO_LOCK_TTL_SECONDS'] ?? '900', 10);

// Sweep locks expire after 7 days (safety net — sweeps should resolve in minutes,
// but if stuck indefinitely the expiry worker will release and unblock coin selection).
const SWEEP_LOCK_TTL_SECONDS = parseInt(
  process.env['SWEEP_UTXO_LOCK_TTL_SECONDS'] ?? String(7 * 24 * 3600),
  10,
);

export const utxoLockService = {
  /**
   * Select available UTXOs and lock them atomically for a batch.
   * Returns the locked UTXOs or throws if locking fails.
   *
   * Uses a transaction to serialize concurrent access.
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
        ORDER BY CAST(amount_raw AS BIGINT) ASC
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
          throw new Error(
            `UTXO ${utxo.tx_hash}:${utxo.vout} was locked concurrently — retry coin selection`
          );
        }

        // Record the lock in utxo_locks for audit/cleanup
        const lockId = `ulk_${crypto.randomBytes(8).toString('hex')}`;
        await tx.run(`
          INSERT INTO utxo_locks (id, tenant_id, reference_id, reference_type, chain_id, tx_hash, vout, amount_raw,
                                  status, locked_at, expires_at)
          VALUES (?, ?, ?, 'batch', ?, ?, ?, ?, 'locked', ?, ?)
          ON CONFLICT(chain_id, tx_hash, vout) DO UPDATE SET
            status         = 'locked',
            reference_id   = excluded.reference_id,
            reference_type = excluded.reference_type,
            locked_at      = excluded.locked_at,
            expires_at     = excluded.expires_at,
            released_at    = NULL
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
      const locks = await tx.all<{ chain_id: string; tx_hash: string; vout: number }>(`
        SELECT chain_id, tx_hash, vout
        FROM utxo_locks
        WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'batch' AND status = 'locked'
      `, [tenantId, batchId]);

      const now = new Date().toISOString();

      for (const lock of locks) {
        await tx.run(`
          UPDATE cached_utxos
          SET is_locked = 0
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [tenantId, lock.chain_id, lock.tx_hash, lock.vout]);

        await tx.run(`
          UPDATE utxo_locks
          SET status = 'released', released_at = ?
          WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'batch'
            AND chain_id = ? AND tx_hash = ? AND vout = ?
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
        WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'batch' AND status = 'locked'
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
          WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'batch'
            AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [tenantId, batchId, lock.chain_id, lock.tx_hash, lock.vout]);
      }

      logger.debug('UTXOs marked as spent for batch', { tenantId, batchId, count: locks.length });
    });
  },

  /**
   * Return locked UTXOs for a batch.
   * Used by withdrawal-batcher to rebuild the PSBT inputs for RBF/CPFP.
   */
  async getLockedForBatch(
    tenantId: string,
    batchId: string,
  ): Promise<Array<{ tx_hash: string; vout: number; amount_raw: string }>> {
    const db = getDbClient();
    return db.all<{ tx_hash: string; vout: number; amount_raw: string }>(`
      SELECT tx_hash, vout, amount_raw
      FROM utxo_locks
      WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'batch' AND status = 'locked'
    `, [tenantId, batchId]);
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
        INSERT INTO utxo_locks (id, tenant_id, reference_id, reference_type, chain_id, tx_hash, vout, amount_raw, status, locked_at, expires_at)
        VALUES (?, ?, ?, 'batch', ?, ?, ?, ?, 'locked', ?, ?)
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
        UPDATE utxo_locks SET reference_id = ?, expires_at = ?
        WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'batch' AND status = 'locked'
      `, [toBatchId, newExpiresAt, tenantId, fromBatchId]);
    } else {
      await db.run(`
        UPDATE utxo_locks SET reference_id = ?
        WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'batch' AND status = 'locked'
      `, [toBatchId, tenantId, fromBatchId]);
    }
  },

  /**
   * Cleanup expired UTXO locks.
   * Called by the signing task expiry worker.
   * Covers both batch locks (short TTL) and sweep locks (7-day safety-net TTL).
   */
  async cleanupExpiredLocks(): Promise<number> {
    const db = getDbClient();
    const now = new Date().toISOString();

    const result = await db.transaction(async (tx) => {
      const expired = await tx.all<{
        tenant_id: string;
        reference_id: string;
        reference_type: string;
        chain_id: string;
        tx_hash: string;
        vout: number;
      }>(`
        SELECT tenant_id, reference_id, reference_type, chain_id, tx_hash, vout
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

  // ──────────────────────────────────────────────────────────────
  // Sweep-specific lock operations
  // ──────────────────────────────────────────────────────────────

  /**
   * Lock a pre-selected list of customer-deposit UTXOs for a sweep.
   *
   * Unlike lockUtxosForBatch, this method does NOT select UTXOs — the caller
   * (SweepWorker) already selected them via collectSweepableUtxos().
   * We only perform the atomic lock here.
   *
   * In PostgreSQL (active-active engine cluster), two sweep workers could race.
   * The UPDATE WHERE is_locked=0 AND is_spent=0 is atomic under MVCC:
   * one worker will get changes=0 and the whole transaction rolls back.
   */
  async lockUtxosForSweep(
    tenantId: string,
    sweepId: string,
    chainId: string,
    utxos: Array<{ tx_hash: string; vout: number; amount_raw: string }>
  ): Promise<void> {
    const db = getDbClient();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SWEEP_LOCK_TTL_SECONDS * 1000).toISOString();

    await db.transaction(async (tx) => {
      for (const utxo of utxos) {
        const result = await tx.run(`
          UPDATE cached_utxos
          SET is_locked = 1
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
            AND is_locked = 0 AND is_spent = 0
        `, [tenantId, chainId, utxo.tx_hash, utxo.vout]);

        if (result.changes === 0) {
          throw new Error(
            `UTXO ${utxo.tx_hash}:${utxo.vout} no longer available (concurrently locked or spent)`
          );
        }

        const lockId = `ulk_${crypto.randomBytes(8).toString('hex')}`;
        await tx.run(`
          INSERT INTO utxo_locks
            (id, tenant_id, reference_id, reference_type, chain_id, tx_hash, vout, amount_raw,
             status, locked_at, expires_at)
          VALUES (?, ?, ?, 'sweep', ?, ?, ?, ?, 'locked', ?, ?)
          ON CONFLICT(chain_id, tx_hash, vout) DO UPDATE SET
            reference_id   = excluded.reference_id,
            reference_type = 'sweep',
            status         = 'locked',
            locked_at      = excluded.locked_at,
            expires_at     = excluded.expires_at,
            released_at    = NULL
        `, [lockId, tenantId, sweepId, chainId, utxo.tx_hash, utxo.vout, utxo.amount_raw, now, expiresAt]);
      }

      logger.debug('UTXOs locked for sweep', { tenantId, sweepId, count: utxos.length });
    });
  },

  /**
   * Release UTXO locks for a sweep.
   * Called when a sweep fails (broadcast error or PSBT finalization error).
   * Idempotent — safe to call multiple times.
   */
  async releaseLocksForSweep(tenantId: string, sweepId: string): Promise<void> {
    const db = getDbClient();

    await db.transaction(async (tx) => {
      const locks = await tx.all<{ chain_id: string; tx_hash: string; vout: number }>(`
        SELECT chain_id, tx_hash, vout
        FROM utxo_locks
        WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'sweep' AND status = 'locked'
      `, [tenantId, sweepId]);

      const now = new Date().toISOString();

      for (const lock of locks) {
        await tx.run(`
          UPDATE cached_utxos SET is_locked = 0
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [tenantId, lock.chain_id, lock.tx_hash, lock.vout]);

        await tx.run(`
          UPDATE utxo_locks SET status = 'released', released_at = ?
          WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'sweep'
            AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [now, tenantId, sweepId, lock.chain_id, lock.tx_hash, lock.vout]);
      }

      logger.debug('UTXO locks released for sweep', { tenantId, sweepId, count: locks.length });
    });
  },

  /**
   * Mark sweep UTXOs as spent and close the audit record.
   * Called by SweepConfirmationWorker after sweep status → 'confirmed'.
   *
   * The btc-indexer independently calls markSpentByUtxo() when it processes
   * the utxo_spent chain_event, which also sets is_spent=1. Both are idempotent.
   */
  async markSpentForSweep(tenantId: string, sweepId: string): Promise<void> {
    const db = getDbClient();

    await db.transaction(async (tx) => {
      const locks = await tx.all<{ chain_id: string; tx_hash: string; vout: number }>(`
        SELECT chain_id, tx_hash, vout
        FROM utxo_locks
        WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'sweep' AND status = 'locked'
      `, [tenantId, sweepId]);

      for (const lock of locks) {
        await tx.run(`
          UPDATE cached_utxos SET is_locked = 0, is_spent = 1
          WHERE tenant_id = ? AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [tenantId, lock.chain_id, lock.tx_hash, lock.vout]);

        await tx.run(`
          UPDATE utxo_locks SET status = 'spent'
          WHERE tenant_id = ? AND reference_id = ? AND reference_type = 'sweep'
            AND chain_id = ? AND tx_hash = ? AND vout = ?
        `, [tenantId, sweepId, lock.chain_id, lock.tx_hash, lock.vout]);
      }

      logger.debug('UTXOs marked as spent for sweep', { tenantId, sweepId, count: locks.length });
    });
  },

  // ──────────────────────────────────────────────────────────────
  // Balance helpers (unchanged)
  // ──────────────────────────────────────────────────────────────

  /**
   * Return confirmed / unconfirmed balance for a single address from cached_utxos.
   * v3: replaces adapter.getAddressBalance() / getReceivedByAddress FWallet calls.
   */
  async getAddressBalance(
    tenantId: string,
    chainId: string,
    address: string
  ): Promise<{ confirmed: string; unconfirmed: string; total: string }> {
    const db = getDbClient();
    const row = await db.get<{ confirmed_sats: string; unconfirmed_sats: string }>(`
      SELECT
        COALESCE(SUM(CASE WHEN confirmations >= 1 THEN CAST(amount_raw AS BIGINT) ELSE 0 END), 0) AS confirmed_sats,
        COALESCE(SUM(CASE WHEN confirmations  = 0 THEN CAST(amount_raw AS BIGINT) ELSE 0 END), 0) AS unconfirmed_sats
      FROM cached_utxos
      WHERE tenant_id = ? AND chain_id = ? AND address = ? AND is_spent = 0
    `, [tenantId, chainId, address]);
    const confirmed   = String(row?.confirmed_sats  ?? '0');
    const unconfirmed = String(row?.unconfirmed_sats ?? '0');
    const total = (BigInt(confirmed) + BigInt(unconfirmed)).toString();
    return { confirmed, unconfirmed, total };
  },

  /**
   * Return confirmed / unconfirmed balances per chain for a wallet from cached_utxos.
   * v3: replaces per-address adapter.getAddressBalance() loops.
   */
  async getWalletBalances(
    walletId: string
  ): Promise<Record<string, { confirmed: string; unconfirmed: string; total: string }>> {
    const db = getDbClient();
    const rows = await db.all<{ chain_id: string; confirmed_sats: string; unconfirmed_sats: string }>(`
      SELECT
        chain_id,
        COALESCE(SUM(CASE WHEN confirmations >= 1 THEN CAST(amount_raw AS BIGINT) ELSE 0 END), 0) AS confirmed_sats,
        COALESCE(SUM(CASE WHEN confirmations  = 0 THEN CAST(amount_raw AS BIGINT) ELSE 0 END), 0) AS unconfirmed_sats
      FROM cached_utxos
      WHERE wallet_id = ? AND is_spent = 0
      GROUP BY chain_id
    `, [walletId]);
    const result: Record<string, { confirmed: string; unconfirmed: string; total: string }> = {};
    for (const row of rows) {
      const confirmed   = String(row.confirmed_sats);
      const unconfirmed = String(row.unconfirmed_sats);
      result[row.chain_id] = {
        confirmed,
        unconfirmed,
        total: (BigInt(confirmed) + BigInt(unconfirmed)).toString(),
      };
    }
    return result;
  },

  // Called by ChainEventProcessorWorker when a utxo_created event is processed.
  /**
   * Synchronises cached_utxos with a deposit event from btc-indexer.
   */
  async upsertFromDeposit(input: {
    tenantId: string; customerId: string | null; walletId: string | null; walletRole: string | null;
    chainId: string; address: string; txHash: string; vout: number;
    amountRaw: string; confirmations: number;
  }): Promise<void> {
    const db = getDbClient();
    const now = new Date().toISOString();
    const id = `utxo_${crypto.randomBytes(8).toString('hex')}`;
    await db.run(`
      INSERT INTO cached_utxos (
        id, tenant_id, customer_id, wallet_id, wallet_role, chain_id,
        address, tx_hash, vout, amount_raw, confirmations, is_spent, is_locked, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      ON CONFLICT(chain_id, tx_hash, vout) DO UPDATE SET
        confirmations = excluded.confirmations,
        is_spent = 0,
        updated_at = excluded.updated_at
    `, [id, input.tenantId, input.customerId, input.walletId, input.walletRole, input.chainId,
      input.address, input.txHash, input.vout, input.amountRaw, input.confirmations, now, now]);
  },

  // Called by ChainEventProcessorWorker when a utxo_spent chain_event is processed.
  async markSpentByUtxo(chainId: string, txHash: string, vout: number): Promise<void> {
    const db = getDbClient();
    await db.run(
      'UPDATE cached_utxos SET is_spent = 1, is_locked = 0, updated_at = ? WHERE chain_id = ? AND tx_hash = ? AND vout = ?',
      [new Date().toISOString(), chainId, txHash, vout]
    );
  },
};
