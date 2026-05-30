/**
 * Signing Tasks Service
 *
 * Manages the lifecycle of signing tasks:
 * created → available → claimed → signed → submitted
 *                   ↘ rejected / expired / failed
 */

import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ValidationError } from '../../shared/errors/index';
import { logger } from '../../shared/logging/index';
import { utxoLockService } from '../../shared/utxo-lock/utxo-lock.service';
// Lazy import to avoid circular dependency — batcher depends on signing-tasks
let _withdrawalBatcherService: typeof import('../withdrawal-batches/withdrawal-batcher.service').withdrawalBatcherService | null = null;
async function getBatcherService() {
  if (!_withdrawalBatcherService) {
    const mod = await import('../withdrawal-batches/withdrawal-batcher.service');
    _withdrawalBatcherService = mod.withdrawalBatcherService;
  }
  return _withdrawalBatcherService;
}

const TASK_TTL_SECONDS = parseInt(process.env['SIGNING_TASK_TTL_SECONDS'] ?? '300', 10);

export interface SigningTask {
  id: string;
  tenant_id: string;
  signer_id: string | null;
  request_type: string;
  chain_id: string;
  asset_id: string;
  withdrawal_batch_id: string | null;
  sweep_id: string | null;
  transaction_id: string | null;
  amount_raw: string;
  fee_raw: string | null;
  fee_rate_sat_vb: string | null;
  outputs_count: number | null;
  payload_format: string;
  unsigned_payload: string;
  unsigned_payload_hash: string;
  status: string;
  decision_mode: string;
  decision_reason: string | null;
  claimed_by_signer_id: string | null;
  claimed_at: string | null;
  expires_at: string | null;
  signed_payload: string | null;
  signed_payload_hash: string | null;
  signer_fingerprint: string | null;
  signer_response_signature: string | null;
  signed_at: string | null;
  rejection_reason_code: string | null;
  rejection_reason_message: string | null;
  rejected_at: string | null;
  submitted_at: string | null;
  tx_hash: string | null;
  failure_code: string | null;
  failure_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export const signingTasksService = {
  create(input: {
    tenantId: string;
    signerId: string | null;
    requestType: string;
    chainId: string;
    assetId: string;
    withdrawalBatchId?: string;
    sweepId?: string;
    amountRaw: string;
    feeRaw?: string;
    feeRateSatVb?: string;
    outputsCount?: number;
    payloadFormat: string;
    unsignedPayload: string;
    decisionMode: string;
    decisionReason?: string;
  }): SigningTask {
    const db = getDb();
    const id = `sigtsk_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TASK_TTL_SECONDS * 1000).toISOString();

    // SHA-256 hash of the unsigned payload
    const unsignedPayloadHash = crypto
      .createHash('sha256')
      .update(input.unsignedPayload)
      .digest('hex');

    // Status: if manual decision, start at pending_approval; if auto, start at available
    const initialStatus = input.decisionMode === 'manual' ? 'pending_approval' : 'available';

    db.prepare(`
      INSERT INTO signing_tasks (
        id, tenant_id, signer_id,
        request_type, chain_id, asset_id,
        withdrawal_batch_id, sweep_id,
        amount_raw, fee_raw, fee_rate_sat_vb, outputs_count,
        payload_format, unsigned_payload, unsigned_payload_hash,
        status, decision_mode, decision_reason,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.tenantId, input.signerId,
      input.requestType, input.chainId, input.assetId,
      input.withdrawalBatchId ?? null, input.sweepId ?? null,
      input.amountRaw, input.feeRaw ?? null, input.feeRateSatVb ?? null, input.outputsCount ?? null,
      input.payloadFormat, input.unsignedPayload, unsignedPayloadHash,
      initialStatus, input.decisionMode, input.decisionReason ?? null,
      expiresAt, now, now
    );

    logger.info('Signing task created', { id, tenantId: input.tenantId, status: initialStatus });
    return signingTasksService.getByIdInternal(id);
  },

  getByIdInternal(id: string): SigningTask {
    const db = getDb();
    const row = db.prepare('SELECT * FROM signing_tasks WHERE id = ?').get(id) as SigningTask | undefined;
    if (!row) throw new NotFoundError('SigningTask', id);
    return row;
  },

  getById(tenantId: string, id: string): SigningTask {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM signing_tasks WHERE id = ? AND tenant_id = ?'
    ).get(id, tenantId) as SigningTask | undefined;
    if (!row) throw new NotFoundError('SigningTask', id);
    return row;
  },

  list(tenantId: string, filters: {
    status?: string;
    chainId?: string;
    requestType?: string;
    limit?: number;
    cursor?: string;
  } = {}): { data: SigningTask[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM signing_tasks WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.chainId) { query += ' AND chain_id = ?'; params.push(filters.chainId); }
    if (filters.requestType) { query += ' AND request_type = ?'; params.push(filters.requestType); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as SigningTask[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { data: items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  },

  /**
   * List tasks that are available for a specific signer to claim.
   */
  listAvailableForSigner(tenantId: string, signerId: string, limit = 10): SigningTask[] {
    const db = getDb();
    const now = new Date().toISOString();

    return db.prepare(`
      SELECT * FROM signing_tasks
      WHERE tenant_id = ?
        AND (signer_id = ? OR signer_id IS NULL)
        AND status = 'available'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(tenantId, signerId, now, limit) as SigningTask[];
  },

  /**
   * Claim a task for signing. Idempotent if already claimed by same signer.
   */
  async claimTask(tenantId: string, taskId: string, signerId: string): Promise<SigningTask> {
    const task = signingTasksService.getById(tenantId, taskId);

    if (task.status === 'claimed' && task.claimed_by_signer_id === signerId) {
      return task; // Idempotent
    }

    if (task.status !== 'available') {
      throw new ValidationError(`Task ${taskId} is in status '${task.status}', cannot claim`);
    }

    // Check expiry
    if (task.expires_at && new Date(task.expires_at) < new Date()) {
      signingTasksService.expireTask(taskId);
      throw new ValidationError(`Task ${taskId} has expired`);
    }

    const db = getDb();
    const now = new Date().toISOString();

    const result = db.prepare(`
      UPDATE signing_tasks
      SET status = 'claimed', claimed_by_signer_id = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'available'
    `).run(signerId, now, now, taskId);

    if (result.changes === 0) {
      throw new ValidationError(`Task ${taskId} was concurrently claimed by another signer`);
    }

    logger.info('Signing task claimed', { taskId, signerId, tenantId });
    return signingTasksService.getByIdInternal(taskId);
  },

  /**
   * Submit a signed payload. Validates idempotency and status.
   */
  async submitSignedTask(
    tenantId: string,
    taskId: string,
    signerId: string,
    input: {
      signedPayload: string;
      signedPayloadHash: string;
      signerFingerprint: string;
      signerResponseSignature?: string;
      signedAt?: string;
    }
  ): Promise<SigningTask> {
    const task = signingTasksService.getById(tenantId, taskId);

    if (task.status === 'signed' || task.status === 'submitted') {
      return task; // Idempotent
    }

    if (task.status !== 'claimed') {
      throw new ValidationError(`Task ${taskId} is in status '${task.status}', expected 'claimed'`);
    }

    if (task.claimed_by_signer_id !== signerId) {
      throw new ValidationError(`Task ${taskId} was not claimed by signer ${signerId}`);
    }

    // Verify payload hash
    const computedHash = crypto
      .createHash('sha256')
      .update(input.signedPayload)
      .digest('hex');

    if (computedHash !== input.signedPayloadHash) {
      throw new ValidationError('signedPayloadHash does not match signed payload');
    }

    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE signing_tasks
      SET status = 'signed',
          signed_payload = ?,
          signed_payload_hash = ?,
          signer_fingerprint = ?,
          signer_response_signature = ?,
          signed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.signedPayload,
      input.signedPayloadHash,
      input.signerFingerprint,
      input.signerResponseSignature ?? null,
      input.signedAt ?? now,
      now,
      taskId
    );

    // Record in audit log
    signingTasksService.recordAudit(task, 'signed', signerId, input.signedPayloadHash);

    logger.info('Signing task signed', { taskId, signerId, tenantId });

    // Auto-finalize withdrawal batch — fire-and-forget, errors are logged not thrown
    if (task.withdrawal_batch_id) {
      const batchId = task.withdrawal_batch_id;
      setImmediate(async () => {
        try {
          const batcher = await getBatcherService();
          await batcher.finalizeBatch(tenantId, batchId);
          logger.info('Withdrawal batch finalized after signing', { batchId, taskId, tenantId });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('Failed to auto-finalize batch after signing', { batchId, taskId, tenantId, error: msg });
        }
      });
    }

    return signingTasksService.getByIdInternal(taskId);
  },

  /**
   * Reject a task (signer refused to sign, e.g. policy violation).
   */
  async rejectTask(
    tenantId: string,
    taskId: string,
    signerId: string,
    input: {
      reasonCode: string;
      reasonMessage: string;
      rejectedAt?: string;
    }
  ): Promise<SigningTask> {
    const task = signingTasksService.getById(tenantId, taskId);

    if (task.status === 'rejected') return task; // Idempotent

    if (!['claimed', 'available'].includes(task.status)) {
      throw new ValidationError(`Task ${taskId} is in status '${task.status}', cannot reject`);
    }

    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE signing_tasks
      SET status = 'rejected',
          rejection_reason_code = ?,
          rejection_reason_message = ?,
          rejected_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(input.reasonCode, input.reasonMessage, input.rejectedAt ?? now, now, taskId);

    // Release UTXO locks and revert batch + withdrawals to queued so batcher retries
    if (task.withdrawal_batch_id) {
      try {
        utxoLockService.releaseLocksForBatch(tenantId, task.withdrawal_batch_id);
      } catch (err) {
        logger.warn('Failed to release UTXO locks on task rejection', { taskId, error: String(err) });
      }
      try {
        const batcher = await getBatcherService();
        batcher.onSigningTaskRejected(
          tenantId,
          task.withdrawal_batch_id,
          `Signing task rejected: ${input.reasonCode} — ${input.reasonMessage}`
        );
      } catch (err) {
        logger.warn('Failed to revert batch/withdrawals on task rejection', { taskId, batchId: task.withdrawal_batch_id, error: String(err) });
      }
    }

    signingTasksService.recordAudit(task, 'rejected', signerId, null, {
      errorCode: input.reasonCode,
      errorMessage: input.reasonMessage,
    });

    logger.info('Signing task rejected', { taskId, signerId, reasonCode: input.reasonCode });
    return signingTasksService.getByIdInternal(taskId);
  },

  /**
   * Approve a task for signing (manual approval flow).
   */
  approveTask(tenantId: string, taskId: string, approvedBy: string): SigningTask {
    const task = signingTasksService.getById(tenantId, taskId);

    if (task.status !== 'pending_approval') {
      throw new ValidationError(`Task ${taskId} is in status '${task.status}', expected 'pending_approval'`);
    }

    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE signing_tasks
      SET status = 'available', decision_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(`manual_approved_by:${approvedBy}`, now, taskId);

    return signingTasksService.getByIdInternal(taskId);
  },

  /**
   * Manually reject a task (tenant UI decision).
   */
  manualRejectTask(tenantId: string, taskId: string, rejectedBy: string, reason: string): SigningTask {
    const task = signingTasksService.getById(tenantId, taskId);

    if (!['pending_approval', 'available', 'created'].includes(task.status)) {
      throw new ValidationError(`Task ${taskId} is in status '${task.status}', cannot reject`);
    }

    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE signing_tasks
      SET status = 'cancelled',
          rejection_reason_code = 'manual_rejection',
          rejection_reason_message = ?,
          updated_at = ?
      WHERE id = ?
    `).run(`Rejected by ${rejectedBy}: ${reason}`, now, taskId);

    // Release UTXO locks
    if (task.withdrawal_batch_id) {
      try {
        utxoLockService.releaseLocksForBatch(tenantId, task.withdrawal_batch_id);
      } catch (err) {
        logger.warn('Failed to release UTXO locks on manual rejection', { taskId, error: String(err) });
      }
    }

    return signingTasksService.getByIdInternal(taskId);
  },

  expireTask(taskId: string): void {
    const db = getDb();
    const now = new Date().toISOString();

    const row = db.prepare(
      'SELECT tenant_id, withdrawal_batch_id, status FROM signing_tasks WHERE id = ?'
    ).get(taskId) as { tenant_id: string; withdrawal_batch_id: string | null; status: string } | undefined;

    if (!row || ['signed', 'submitted', 'expired', 'cancelled'].includes(row.status)) return;

    db.prepare(`
      UPDATE signing_tasks
      SET status = 'expired', updated_at = ?
      WHERE id = ? AND status NOT IN ('signed', 'submitted', 'expired', 'cancelled')
    `).run(now, taskId);

    // Release UTXO locks
    if (row.withdrawal_batch_id) {
      try {
        utxoLockService.releaseLocksForBatch(row.tenant_id, row.withdrawal_batch_id);
      } catch (err) {
        logger.warn('Failed to release UTXO locks on task expiry', { taskId, error: String(err) });
      }
    }
  },

  /**
   * Expire all tasks past their expiry time.
   * Called by the expiry worker.
   */
  expireAllOverdue(): number {
    const db = getDb();
    const now = new Date().toISOString();

    const overdue = db.prepare(`
      SELECT id, tenant_id, withdrawal_batch_id
      FROM signing_tasks
      WHERE expires_at < ?
        AND status NOT IN ('signed', 'submitted', 'expired', 'cancelled', 'rejected', 'failed')
    `).all(now) as Array<{ id: string; tenant_id: string; withdrawal_batch_id: string | null }>;

    for (const task of overdue) {
      signingTasksService.expireTask(task.id);
    }

    return overdue.length;
  },

  markSubmitted(taskId: string, txHash: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE signing_tasks
      SET status = 'submitted', submitted_at = ?, tx_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(now, txHash, now, taskId);
  },

  recordAudit(
    task: SigningTask,
    result: string,
    actorId: string,
    signedPayloadHash: string | null,
    extra?: { errorCode?: string; errorMessage?: string }
  ): void {
    try {
      const db = getDb();
      const id = `saud_${crypto.randomBytes(8).toString('hex')}`;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO signer_signature_audit (
          id, tenant_id, signing_task_id, signer_id,
          decision_mode, signed_by_actor_type, signed_by_actor_id,
          chain_id, asset_id, amount_raw,
          unsigned_payload_hash, signed_payload_hash,
          signature_result, error_code, error_message,
          created_at
        ) VALUES (?, ?, ?, ?, ?, 'signer_daemon', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, task.tenant_id, task.id, task.signer_id,
        task.decision_mode, actorId,
        task.chain_id, task.asset_id, task.amount_raw,
        task.unsigned_payload_hash, signedPayloadHash,
        result,
        extra?.errorCode ?? null,
        extra?.errorMessage ?? null,
        now
      );
    } catch (err) {
      logger.warn('Failed to record signature audit', { taskId: task.id, error: String(err) });
    }
  },
};
