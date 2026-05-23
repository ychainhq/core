/**
 * Withdrawal Batcher Service
 *
 * Builds BTC withdrawal batches from queued customer_withdrawals.
 * Handles:
 * - UTXO selection and locking
 * - PSBT building
 * - Fee sanity check
 * - Dust check
 * - Signing task creation
 * - Batch finalization after signing
 */

import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ValidationError, UnprocessableEntityError } from '../../shared/errors/index';
import { logger } from '../../shared/logging/index';
import { utxoLockService } from '../../shared/utxo-lock/utxo-lock.service';
import { externalSignersService } from '../external-signers/external-signers.service';
import { signerPolicyService } from '../external-signers/signer-policy.service';
import { signingTasksService } from '../signing-tasks/signing-tasks.service';
import { BitcoinAdapter } from '../../chain-adapters/bitcoin/adapter';

// BTC dust threshold for P2WPKH outputs (546 sats)
const DUST_THRESHOLD_SATS = 546n;
const FEE_RATE_CACHE_TTL_MS = parseInt(process.env['BTC_FEE_RATE_CACHE_TTL_MS'] ?? '30000', 10);

const feeRateCache = new Map<string, { feeRate: number; expiresAt: number }>();

async function estimateFeeRateCached(input: {
  adapter: BitcoinAdapter;
  tenantId: string;
  targetBlocks: number;
  maxFeeRateSatVb: number;
  minFeeRateSatVb: number | null;
}): Promise<number> {
  const key = `${input.targetBlocks}:${input.maxFeeRateSatVb}:${input.minFeeRateSatVb ?? ''}`;
  const cached = feeRateCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.feeRate;
  }

  let feeRateSatVb = input.maxFeeRateSatVb;
  try {
    const feeEst = await input.adapter.estimateSmartFee(input.targetBlocks);
    feeRateSatVb = Math.min(feeEst.feeRate, input.maxFeeRateSatVb);
    if (input.minFeeRateSatVb) {
      feeRateSatVb = Math.max(feeRateSatVb, input.minFeeRateSatVb);
    }
    feeRateCache.set(key, { feeRate: feeRateSatVb, expiresAt: Date.now() + FEE_RATE_CACHE_TTL_MS });
  } catch (err) {
    logger.warn('Fee estimation failed, using fallback', { tenantId: input.tenantId, error: String(err) });
  }

  return feeRateSatVb;
}

export interface WithdrawalBatch {
  id: string;
  tenant_id: string;
  chain_id: string;
  asset_id: string;
  status: string;
  outputs_count: number;
  total_output_raw: string;
  fee_raw: string | null;
  fee_rate_sat_vb: string | null;
  psbt: string | null;
  signed_psbt: string | null;
  raw_tx: string | null;
  tx_hash: string | null;
  rbf_enabled: number;
  sequence: number | null;
  signing_task_id: string | null;
  signer_id: string | null;
  decision_mode: string;
  approved_by: string | null;
  approved_at: string | null;
  attempt_count: number;
  last_error: string | null;
  replaced_by_batch_id: string | null;
  replacement_of_batch_id: string | null;
  created_at: string;
  updated_at: string;
  broadcast_at: string | null;
}

interface BatchConfig {
  btc_batching_enabled: number;
  btc_batch_interval_seconds: number;
  btc_max_outputs_per_batch: number;
  btc_min_outputs_per_batch: number;
  btc_max_batch_age_seconds: number;
  btc_max_batch_total_sats: string | null;
  btc_max_single_withdrawal_sats: string | null;
  btc_min_withdrawal_sats: string | null;
  btc_fee_policy: string;
  btc_target_blocks: number;
  btc_max_fee_rate_sat_vb: number;
  btc_min_fee_rate_sat_vb: number | null;
  btc_fee_sanity_max_fee_sats: string | null;
  btc_fee_sanity_max_fee_percent_bps: number | null;
  btc_dust_policy: string;
  btc_change_address_policy: string;
  btc_rbf_enabled: number;
  btc_rbf_strategy: string;
  btc_cpfp_enabled: number;
  btc_batch_retry_max_attempts: number;
}

function getDefaultConfig(): BatchConfig {
  return {
    btc_batching_enabled: 1,
    btc_batch_interval_seconds: 300,
    btc_max_outputs_per_batch: 200,
    btc_min_outputs_per_batch: 1,
    btc_max_batch_age_seconds: 300,
    btc_max_batch_total_sats: null,
    btc_max_single_withdrawal_sats: null,
    btc_min_withdrawal_sats: null,
    btc_fee_policy: 'target_blocks',
    btc_target_blocks: 6,
    btc_max_fee_rate_sat_vb: 50,
    btc_min_fee_rate_sat_vb: null,
    btc_fee_sanity_max_fee_sats: null,
    btc_fee_sanity_max_fee_percent_bps: null,
    btc_dust_policy: 'reject',
    btc_change_address_policy: 'tenant_hot_change',
    btc_rbf_enabled: 1,
    btc_rbf_strategy: 'opt_in',
    btc_cpfp_enabled: 0,
    btc_batch_retry_max_attempts: 3,
  };
}

export const withdrawalBatcherService = {
  getBatchConfig(tenantId: string): BatchConfig {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM tenant_withdrawal_batch_configs WHERE tenant_id = ?'
    ).get(tenantId) as BatchConfig | undefined;
    return row ?? getDefaultConfig();
  },

  upsertBatchConfig(tenantId: string, input: Partial<BatchConfig>): BatchConfig {
    const db = getDb();
    const existing = db.prepare(
      'SELECT * FROM tenant_withdrawal_batch_configs WHERE tenant_id = ?'
    ).get(tenantId);

    const now = new Date().toISOString();

    if (!existing) {
      const def = getDefaultConfig();
      const merged = { ...def, ...input };
      db.prepare(`
        INSERT INTO tenant_withdrawal_batch_configs (
          tenant_id,
          btc_batching_enabled, btc_batch_interval_seconds,
          btc_max_outputs_per_batch, btc_min_outputs_per_batch, btc_max_batch_age_seconds,
          btc_max_batch_total_sats, btc_max_single_withdrawal_sats, btc_min_withdrawal_sats,
          btc_fee_policy, btc_target_blocks, btc_max_fee_rate_sat_vb, btc_min_fee_rate_sat_vb,
          btc_fee_sanity_max_fee_sats, btc_fee_sanity_max_fee_percent_bps,
          btc_dust_policy, btc_change_address_policy,
          btc_rbf_enabled, btc_rbf_strategy, btc_cpfp_enabled,
          btc_batch_retry_max_attempts, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenantId,
        merged.btc_batching_enabled, merged.btc_batch_interval_seconds,
        merged.btc_max_outputs_per_batch, merged.btc_min_outputs_per_batch, merged.btc_max_batch_age_seconds,
        merged.btc_max_batch_total_sats, merged.btc_max_single_withdrawal_sats, merged.btc_min_withdrawal_sats,
        merged.btc_fee_policy, merged.btc_target_blocks, merged.btc_max_fee_rate_sat_vb, merged.btc_min_fee_rate_sat_vb,
        merged.btc_fee_sanity_max_fee_sats, merged.btc_fee_sanity_max_fee_percent_bps,
        merged.btc_dust_policy, merged.btc_change_address_policy,
        merged.btc_rbf_enabled, merged.btc_rbf_strategy, merged.btc_cpfp_enabled,
        merged.btc_batch_retry_max_attempts, now
      );
    } else {
      // Build dynamic update
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
          sets.push(`${key} = ?`);
          params.push(value);
        }
      }
      params.push(tenantId);
      db.prepare(`UPDATE tenant_withdrawal_batch_configs SET ${sets.join(', ')} WHERE tenant_id = ?`).run(...params);
    }

    return withdrawalBatcherService.getBatchConfig(tenantId);
  },

  /**
   * Main batch building entry point.
   * Called by the withdrawal batcher worker.
   */
  async buildBatchForTenant(tenantId: string): Promise<WithdrawalBatch | null> {
    const db = getDb();
    const config = withdrawalBatcherService.getBatchConfig(tenantId);

    if (!config.btc_batching_enabled) return null;

    // Get queued withdrawals
    const maxAge = config.btc_max_batch_age_seconds;
    const cutoffTime = new Date(Date.now() - maxAge * 1000).toISOString();

    const queuedWithdrawals = db.prepare(`
      SELECT cw.*
      FROM customer_withdrawals cw
      WHERE cw.tenant_id = ?
        AND cw.status = 'queued'
        AND cw.chain_id = 'bitcoin'
      ORDER BY cw.created_at ASC
      LIMIT ?
    `).all(tenantId, config.btc_max_outputs_per_batch) as any[];

    if (queuedWithdrawals.length === 0) return null;

    // Check if we should batch now: either hit max outputs or oldest withdrawal exceeds age
    const shouldBatch =
      queuedWithdrawals.length >= config.btc_max_outputs_per_batch ||
      (queuedWithdrawals.length >= config.btc_min_outputs_per_batch &&
        queuedWithdrawals[0]!.created_at < cutoffTime);

    if (!shouldBatch) return null;

    // Dust and amount validation
    const validWithdrawals = [];
    for (const wd of queuedWithdrawals) {
      const amount = BigInt(wd.amount_raw);

      // Dust check
      if (amount < DUST_THRESHOLD_SATS) {
        if (config.btc_dust_policy === 'reject') {
          logger.warn('Dust withdrawal skipped', { tenantId, withdrawalId: wd.id, amount: wd.amount_raw });
          await db.prepare(
            `UPDATE customer_withdrawals SET status = 'failed', error = 'dust_output', updated_at = ? WHERE id = ?`
          ).run(new Date().toISOString(), wd.id);
          continue;
        }
      }

      // Max single withdrawal check
      if (config.btc_max_single_withdrawal_sats && amount > BigInt(config.btc_max_single_withdrawal_sats)) {
        logger.warn('Withdrawal exceeds max single limit, skipping from batch', { tenantId, withdrawalId: wd.id });
        continue;
      }

      validWithdrawals.push(wd);
    }

    if (validWithdrawals.length === 0) return null;

    const totalOutput = validWithdrawals.reduce((sum: bigint, w: any) => sum + BigInt(w.amount_raw), 0n);

    // Check batch total limit
    if (config.btc_max_batch_total_sats && totalOutput > BigInt(config.btc_max_batch_total_sats)) {
      logger.warn('Batch total exceeds limit, skipping batch', { tenantId, total: totalOutput.toString() });
      return null;
    }

    // Estimate fee rate
    const adapter = new BitcoinAdapter();
    const feeRateSatVb = await estimateFeeRateCached({
      adapter,
      tenantId,
      targetBlocks: config.btc_target_blocks,
      maxFeeRateSatVb: config.btc_max_fee_rate_sat_vb,
      minFeeRateSatVb: config.btc_min_fee_rate_sat_vb,
    });

    // Find change address (tenant hot wallet)
    const changeAddrRow = db.prepare(`
      SELECT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
      LIMIT 1
    `).get(tenantId) as { address: string } | undefined;

    if (!changeAddrRow) {
      logger.warn('No tenant hot wallet address for change output', { tenantId });
      return null;
    }

    // Estimate vsize: roughly 10 bytes overhead + 41*inputs + 31*outputs (P2WPKH estimate)
    // Use a generous buffer: 2 inputs assumed initially
    const estimatedInputs = 2;
    const estimatedVsize = 10 + 41 * estimatedInputs + 31 * (validWithdrawals.length + 1); // +1 for change
    const estimatedFeeSats = BigInt(Math.ceil(estimatedVsize * feeRateSatVb));

    // Fee sanity check
    if (config.btc_fee_sanity_max_fee_sats && estimatedFeeSats > BigInt(config.btc_fee_sanity_max_fee_sats)) {
      logger.warn('Fee sanity check failed (max fee sats)', {
        tenantId, estimatedFeeSats: estimatedFeeSats.toString(), limit: config.btc_fee_sanity_max_fee_sats
      });
      return null;
    }

    if (config.btc_fee_sanity_max_fee_percent_bps && totalOutput > 0n) {
      const feePercBps = Number((estimatedFeeSats * 10000n) / totalOutput);
      if (feePercBps > config.btc_fee_sanity_max_fee_percent_bps) {
        logger.warn('Fee sanity check failed (fee percent)', { tenantId, feePercBps, limit: config.btc_fee_sanity_max_fee_percent_bps });
        return null;
      }
    }

    // Create batch record
    const batchId = `wdb_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO withdrawal_batches (
        id, tenant_id, chain_id, asset_id,
        status, outputs_count, total_output_raw, fee_rate_sat_vb,
        rbf_enabled, decision_mode, attempt_count, created_at, updated_at
      ) VALUES (?, ?, 'bitcoin', 'bitcoin:BTC', 'building', ?, ?, ?, ?, 'auto', 0, ?, ?)
    `).run(
      batchId, tenantId,
      validWithdrawals.length, totalOutput.toString(), feeRateSatVb.toString(),
      config.btc_rbf_enabled, now, now
    );

    // Mark withdrawals as batched
    for (const wd of validWithdrawals) {
      db.prepare(`
        INSERT INTO withdrawal_batch_items (batch_id, withdrawal_id, amount_raw, to_address)
        VALUES (?, ?, ?, ?)
      `).run(batchId, wd.id, wd.amount_raw, wd.to_address);

      db.prepare(`
        UPDATE customer_withdrawals SET status = 'batched', updated_at = ? WHERE id = ?
      `).run(now, wd.id);
    }

    // Lock UTXOs
    let lockedUtxos: any[];
    try {
      lockedUtxos = utxoLockService.lockUtxosForBatch(
        tenantId, batchId, 'bitcoin',
        1, // min 1 confirmation
        totalOutput.toString(),
        (estimatedFeeSats * 2n).toString() // 2x fee buffer
      );
    } catch (err) {
      logger.error('UTXO locking failed for batch', { batchId, tenantId, error: String(err) });

      // Undo batch items and revert withdrawal statuses
      db.prepare('DELETE FROM withdrawal_batch_items WHERE batch_id = ?').run(batchId);
      for (const wd of validWithdrawals) {
        db.prepare(`UPDATE customer_withdrawals SET status = 'queued', updated_at = ? WHERE id = ?`)
          .run(now, wd.id);
      }
      db.prepare('DELETE FROM withdrawal_batches WHERE id = ?').run(batchId);
      return null;
    }

    // Build PSBT
    const inputs = lockedUtxos.map(u => ({ txid: u.tx_hash, vout: u.vout }));
    const outputs: Record<string, number>[] = validWithdrawals.map((wd: any) => ({
      [wd.to_address]: Number(BigInt(wd.amount_raw)) / 1e8
    }));

    let psbtBase64: string;
    let actualFeeSats: string;

    try {
      const psbtResult = await adapter.walletCreateFundedPsbt(inputs, outputs, {
        feeRate: feeRateSatVb / 1e5,
        changeAddress: changeAddrRow.address,
      }, tenantId);
      psbtBase64 = psbtResult.psbt;
      actualFeeSats = psbtResult.fee ? String(Math.round(psbtResult.fee * 1e8)) : estimatedFeeSats.toString();
    } catch (err: any) {
      logger.error('PSBT building failed', { batchId, tenantId, error: String(err) });

      utxoLockService.releaseLocksForBatch(tenantId, batchId);
      db.prepare('DELETE FROM withdrawal_batch_items WHERE batch_id = ?').run(batchId);
      for (const wd of validWithdrawals) {
        db.prepare(`UPDATE customer_withdrawals SET status = 'queued', updated_at = ? WHERE id = ?`)
          .run(now, wd.id);
      }
      db.prepare(`UPDATE withdrawal_batches SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
        .run(String(err), now, batchId);
      return withdrawalBatcherService.getBatchById(tenantId, batchId);
    }

    // Update batch with PSBT and fee
    db.prepare(`
      UPDATE withdrawal_batches
      SET psbt = ?, fee_raw = ?, status = 'pending_signature', updated_at = ?
      WHERE id = ?
    `).run(psbtBase64, actualFeeSats, now, batchId);

    // Select signer via round-robin
    const selectedSigner = externalSignersService.selectSigner(tenantId, 'bitcoin', 'bitcoin:BTC', 'btc_psbt');

    // Evaluate policy decision (auto vs manual)
    const policyDecision = signerPolicyService.evaluateDecision(
      tenantId,
      selectedSigner?.id ?? null,
      'bitcoin',
      'bitcoin:BTC',
      totalOutput.toString(),
      feeRateSatVb,
      validWithdrawals.length
    );

    // Update batch decision mode
    db.prepare(`
      UPDATE withdrawal_batches
      SET signer_id = ?, decision_mode = ?, updated_at = ?
      WHERE id = ?
    `).run(selectedSigner?.id ?? null, policyDecision.mode, now, batchId);

    // Create signing task
    const signingTask = signingTasksService.create({
      tenantId,
      signerId: selectedSigner?.id ?? null,
      requestType: 'btc_withdrawal_batch',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      withdrawalBatchId: batchId,
      amountRaw: totalOutput.toString(),
      feeRaw: actualFeeSats,
      feeRateSatVb: feeRateSatVb.toString(),
      outputsCount: validWithdrawals.length,
      payloadFormat: 'btc_psbt',
      unsignedPayload: psbtBase64,
      decisionMode: policyDecision.mode,
      decisionReason: policyDecision.reason,
    });

    // Link task to batch
    db.prepare(`
      UPDATE withdrawal_batches
      SET signing_task_id = ?, updated_at = ?
      WHERE id = ?
    `).run(signingTask.id, now, batchId);

    logger.info('Withdrawal batch created', {
      batchId, tenantId, outputsCount: validWithdrawals.length,
      totalSats: totalOutput.toString(), signingTaskId: signingTask.id
    });

    return withdrawalBatcherService.getBatchById(tenantId, batchId);
  },

  getBatchById(tenantId: string, batchId: string): WithdrawalBatch {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM withdrawal_batches WHERE id = ? AND tenant_id = ?'
    ).get(batchId, tenantId) as WithdrawalBatch | undefined;
    if (!row) throw new NotFoundError('WithdrawalBatch', batchId);
    return row;
  },

  listBatches(tenantId: string, filters: {
    status?: string;
    chainId?: string;
    limit?: number;
    cursor?: string;
  } = {}): { data: WithdrawalBatch[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM withdrawal_batches WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.chainId) { query += ' AND chain_id = ?'; params.push(filters.chainId); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as WithdrawalBatch[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { data: items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  },

  approveBatch(tenantId: string, batchId: string, approvedBy: string): WithdrawalBatch {
    const batch = withdrawalBatcherService.getBatchById(tenantId, batchId);

    if (batch.status !== 'pending_approval') {
      throw new ValidationError(`Batch ${batchId} is in status '${batch.status}', expected 'pending_approval'`);
    }

    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE withdrawal_batches
      SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ?
    `).run(approvedBy, now, now, batchId);

    // Also approve the signing task
    if (batch.signing_task_id) {
      try {
        signingTasksService.approveTask(tenantId, batch.signing_task_id, approvedBy);
      } catch (err) {
        logger.warn('Failed to approve signing task', { batchId, taskId: batch.signing_task_id, error: String(err) });
      }
    }

    return withdrawalBatcherService.getBatchById(tenantId, batchId);
  },

  rejectBatch(tenantId: string, batchId: string, rejectedBy: string, reason: string): WithdrawalBatch {
    const batch = withdrawalBatcherService.getBatchById(tenantId, batchId);

    if (!['pending_approval', 'pending_signature', 'building'].includes(batch.status)) {
      throw new ValidationError(`Batch ${batchId} cannot be rejected in status '${batch.status}'`);
    }

    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE withdrawal_batches SET status = 'rejected', last_error = ?, updated_at = ? WHERE id = ?
    `).run(`Rejected by ${rejectedBy}: ${reason}`, now, batchId);

    // Release UTXO locks and revert withdrawal statuses
    utxoLockService.releaseLocksForBatch(tenantId, batchId);

    db.prepare(`
      UPDATE customer_withdrawals
      SET status = 'queued', updated_at = ?
      WHERE id IN (SELECT withdrawal_id FROM withdrawal_batch_items WHERE batch_id = ?)
    `).run(now, batchId);

    return withdrawalBatcherService.getBatchById(tenantId, batchId);
  },

  cancelBatch(tenantId: string, batchId: string): WithdrawalBatch {
    const batch = withdrawalBatcherService.getBatchById(tenantId, batchId);

    if (['broadcast', 'confirmed', 'cancelled', 'replaced'].includes(batch.status)) {
      throw new ValidationError(`Batch ${batchId} cannot be cancelled in status '${batch.status}'`);
    }

    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`UPDATE withdrawal_batches SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, batchId);

    utxoLockService.releaseLocksForBatch(tenantId, batchId);

    db.prepare(`
      UPDATE customer_withdrawals
      SET status = 'queued', updated_at = ?
      WHERE id IN (SELECT withdrawal_id FROM withdrawal_batch_items WHERE batch_id = ?)
    `).run(now, batchId);

    return withdrawalBatcherService.getBatchById(tenantId, batchId);
  },

  retryBatch(tenantId: string, batchId: string): WithdrawalBatch {
    const batch = withdrawalBatcherService.getBatchById(tenantId, batchId);

    if (!['failed', 'rejected', 'expired'].includes(batch.status)) {
      throw new ValidationError(`Batch ${batchId} cannot be retried in status '${batch.status}'`);
    }

    const db = getDb();
    const now = new Date().toISOString();

    // Revert withdrawals to queued so batcher picks them up again
    db.prepare(`
      UPDATE customer_withdrawals
      SET status = 'queued', updated_at = ?
      WHERE id IN (SELECT withdrawal_id FROM withdrawal_batch_items WHERE batch_id = ?)
    `).run(now, batchId);

    db.prepare(`
      UPDATE withdrawal_batches
      SET status = 'cancelled', attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ?
    `).run(now, batchId);

    return withdrawalBatcherService.getBatchById(tenantId, batchId);
  },

  /**
   * Finalize a signed batch: extract raw tx, testmempoolaccept, broadcast.
   * Called when a signing task transitions to 'signed'.
   */
  async finalizeBatch(tenantId: string, batchId: string): Promise<WithdrawalBatch> {
    const batch = withdrawalBatcherService.getBatchById(tenantId, batchId);

    if (!batch.signing_task_id) {
      throw new ValidationError('Batch has no associated signing task');
    }

    const signingTask = signingTasksService.getByIdInternal(batch.signing_task_id);

    if (signingTask.status !== 'signed') {
      throw new ValidationError(`Signing task is in status '${signingTask.status}', expected 'signed'`);
    }

    if (!signingTask.signed_payload) {
      throw new ValidationError('Signing task has no signed payload');
    }

    const adapter = new BitcoinAdapter();
    const db = getDb();
    const now = new Date().toISOString();

    // Finalize PSBT → raw tx
    let rawTx: string;
    try {
      const finalResult = await adapter.finalizePsbt(signingTask.signed_payload);
      if (!finalResult.complete) {
        throw new Error('PSBT not fully signed — missing signatures');
      }
      rawTx = finalResult.hex;
    } catch (err: any) {
      db.prepare(`
        UPDATE withdrawal_batches
        SET status = 'failed', last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(String(err), now, batchId);
      throw new UnprocessableEntityError(`Failed to finalize PSBT: ${err.message}`);
    }

    // testmempoolaccept
    try {
      const acceptResult = await adapter.testMempoolAccept(rawTx);
      if (!acceptResult.allowed) {
        const errMsg = `testmempoolaccept rejected: ${acceptResult.rejectReason}`;
        db.prepare(`
          UPDATE withdrawal_batches SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
        `).run(errMsg, now, batchId);
        throw new UnprocessableEntityError(errMsg);
      }
    } catch (err: any) {
      if (err instanceof UnprocessableEntityError) throw err;
      logger.warn('testmempoolaccept RPC call failed', { batchId, error: String(err) });
    }

    // Broadcast
    let txHash: string;
    try {
      txHash = await adapter.sendRawTransaction(rawTx);
    } catch (err: any) {
      db.prepare(`
        UPDATE withdrawal_batches SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
      `).run(String(err), now, batchId);
      throw new UnprocessableEntityError(`Failed to broadcast: ${err.message}`);
    }

    // Update batch
    db.prepare(`
      UPDATE withdrawal_batches
      SET status = 'broadcast', raw_tx = ?, tx_hash = ?,
          signed_psbt = ?, broadcast_at = ?, updated_at = ?
      WHERE id = ?
    `).run(rawTx, txHash, signingTask.signed_payload, now, now, batchId);

    // Assign txHash to all withdrawals in batch
    db.prepare(`
      UPDATE customer_withdrawals
      SET status = 'broadcast', tx_hash = ?, updated_at = ?
      WHERE id IN (SELECT withdrawal_id FROM withdrawal_batch_items WHERE batch_id = ?)
    `).run(txHash, now, batchId);

    // Mark UTXOs as spent
    utxoLockService.markSpentForBatch(tenantId, batchId);

    // Mark signing task as submitted
    db.prepare(`
      UPDATE signing_tasks
      SET status = 'submitted', submitted_at = ?, tx_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(now, txHash, now, batch.signing_task_id);

    logger.info('Withdrawal batch broadcast', { batchId, tenantId, txHash, outputsCount: batch.outputs_count });
    return withdrawalBatcherService.getBatchById(tenantId, batchId);
  },

  /**
   * RBF Bump — create a fee-bumped replacement for a broadcast batch.
   *
   * Reuses the original UTXOs (still locked) and rebuilds the PSBT at a higher
   * fee rate. The replacement TX will supersede the original in the mempool
   * (requires the original to have been built with RBF opt-in, sequence < 0xFFFFFFFE).
   */
  async rbfBump(
    tenantId: string,
    batchId: string,
    newFeeRateSatVb: number
  ): Promise<WithdrawalBatch> {
    const batch = withdrawalBatcherService.getBatchById(tenantId, batchId);

    if (batch.status !== 'broadcast') {
      throw new ValidationError(
        `Batch ${batchId} must be in 'broadcast' status for RBF (got '${batch.status}')`
      );
    }
    if (!batch.rbf_enabled) {
      throw new ValidationError(`Batch ${batchId} was not created with RBF opt-in`);
    }

    const batchConfig = withdrawalBatcherService.getBatchConfig(tenantId);
    if (!batchConfig.btc_rbf_enabled) {
      throw new ValidationError('RBF is disabled — enable btcRbfEnabled in tenant batch config');
    }

    const currentFeeRate = batch.fee_rate_sat_vb ? parseFloat(batch.fee_rate_sat_vb) : 0;
    if (newFeeRateSatVb <= currentFeeRate) {
      throw new ValidationError(
        `New fee rate (${newFeeRateSatVb} sat/vb) must exceed current rate (${currentFeeRate} sat/vb)`
      );
    }

    if (newFeeRateSatVb > batchConfig.btc_max_fee_rate_sat_vb) {
      throw new ValidationError(
        `New fee rate (${newFeeRateSatVb} sat/vb) exceeds tenant max (${batchConfig.btc_max_fee_rate_sat_vb} sat/vb)`
      );
    }

    const db = getDb();
    const now = new Date().toISOString();

    // Get locked UTXOs from original batch
    const lockedUtxos = db.prepare(`
      SELECT tx_hash, vout, amount_raw
      FROM utxo_locks
      WHERE tenant_id = ? AND batch_id = ? AND status = 'locked'
    `).all(tenantId, batchId) as Array<{ tx_hash: string; vout: number; amount_raw: string }>;

    if (lockedUtxos.length === 0) {
      throw new ValidationError(`No locked UTXOs found for batch ${batchId}`);
    }

    // Get original withdrawal outputs
    const items = db.prepare(`
      SELECT withdrawal_id, amount_raw, to_address FROM withdrawal_batch_items WHERE batch_id = ?
    `).all(batchId) as Array<{ withdrawal_id: string; amount_raw: string; to_address: string }>;

    const totalOutput = items.reduce((s: bigint, i) => s + BigInt(i.amount_raw), 0n);

    const changeAddrRow = db.prepare(`
      SELECT a.address FROM addresses a JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
      LIMIT 1
    `).get(tenantId) as { address: string } | undefined;

    if (!changeAddrRow) {
      throw new ValidationError('No tenant hot wallet address available for change output');
    }

    const newBatchId = `wdb_${crypto.randomBytes(8).toString('hex')}`;

    db.prepare(`
      INSERT INTO withdrawal_batches (
        id, tenant_id, chain_id, asset_id,
        status, outputs_count, total_output_raw, fee_rate_sat_vb,
        rbf_enabled, replacement_of_batch_id, decision_mode, attempt_count, created_at, updated_at
      ) VALUES (?, ?, 'bitcoin', 'bitcoin:BTC', 'building', ?, ?, ?, 1, ?, 'auto', 0, ?, ?)
    `).run(newBatchId, tenantId, items.length, totalOutput.toString(), newFeeRateSatVb.toString(), batchId, now, now);

    for (const item of items) {
      db.prepare(`
        INSERT INTO withdrawal_batch_items (batch_id, withdrawal_id, amount_raw, to_address)
        VALUES (?, ?, ?, ?)
      `).run(newBatchId, item.withdrawal_id, item.amount_raw, item.to_address);
    }

    // Transfer UTXO locks from original to replacement batch and reset TTL
    const newExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE utxo_locks SET batch_id = ?, expires_at = ?
      WHERE tenant_id = ? AND batch_id = ? AND status = 'locked'
    `).run(newBatchId, newExpiry, tenantId, batchId);

    // Mark original as replaced
    db.prepare(`
      UPDATE withdrawal_batches SET status = 'replaced', replaced_by_batch_id = ?, updated_at = ? WHERE id = ?
    `).run(newBatchId, now, batchId);

    // Build replacement PSBT
    const adapter = new BitcoinAdapter();
    const inputs = lockedUtxos.map(u => ({ txid: u.tx_hash, vout: u.vout }));
    const outputs: Record<string, number>[] = items.map(item => ({
      [item.to_address]: Number(BigInt(item.amount_raw)) / 1e8,
    }));

    let psbtBase64: string;
    let actualFeeSats: string;

    try {
      const psbtResult = await adapter.walletCreateFundedPsbt(inputs, outputs, {
        feeRate: newFeeRateSatVb / 1e5,
        changeAddress: changeAddrRow.address,
      }, tenantId);
      psbtBase64 = psbtResult.psbt;
      actualFeeSats = psbtResult.fee ? String(Math.round(psbtResult.fee * 1e8)) : String(newFeeRateSatVb * 200);
    } catch (err: any) {
      // Roll back: restore original batch, re-assign locks, delete new batch
      db.prepare(`UPDATE utxo_locks SET batch_id = ? WHERE tenant_id = ? AND batch_id = ? AND status = 'locked'`)
        .run(batchId, tenantId, newBatchId);
      db.prepare(`UPDATE withdrawal_batches SET status = 'broadcast', replaced_by_batch_id = NULL, updated_at = ? WHERE id = ?`)
        .run(now, batchId);
      db.prepare('DELETE FROM withdrawal_batch_items WHERE batch_id = ?').run(newBatchId);
      db.prepare('DELETE FROM withdrawal_batches WHERE id = ?').run(newBatchId);
      throw new UnprocessableEntityError(`Failed to build RBF PSBT: ${err.message}`);
    }

    db.prepare(`
      UPDATE withdrawal_batches SET psbt = ?, fee_raw = ?, status = 'pending_signature', updated_at = ? WHERE id = ?
    `).run(psbtBase64, actualFeeSats, now, newBatchId);

    const selectedSigner = externalSignersService.selectSigner(tenantId, 'bitcoin', 'bitcoin:BTC', 'btc_psbt');
    const signingTask = signingTasksService.create({
      tenantId,
      signerId: selectedSigner?.id ?? null,
      requestType: 'btc_withdrawal_batch',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      withdrawalBatchId: newBatchId,
      amountRaw: totalOutput.toString(),
      feeRaw: actualFeeSats,
      feeRateSatVb: newFeeRateSatVb.toString(),
      outputsCount: items.length,
      payloadFormat: 'btc_psbt',
      unsignedPayload: psbtBase64,
      decisionMode: 'auto',
      decisionReason: `RBF replacement of batch ${batchId} at ${newFeeRateSatVb} sat/vb`,
    });

    db.prepare(`UPDATE withdrawal_batches SET signing_task_id = ?, signer_id = ?, updated_at = ? WHERE id = ?`)
      .run(signingTask.id, selectedSigner?.id ?? null, now, newBatchId);

    logger.info('RBF batch created', { originalBatchId: batchId, newBatchId, tenantId, newFeeRateSatVb });
    return withdrawalBatcherService.getBatchById(tenantId, newBatchId);
  },

  /**
   * CPFP — Child-Pays-For-Parent fee bump.
   *
   * Creates a new transaction spending the change output of the broadcast (unconfirmed)
   * batch TX with a high enough fee to incentivize miners to confirm both transactions.
   * Requires btcCpfpEnabled in tenant batch config and the change output to be visible
   * in cached_utxos (i.e. the node has indexed the parent TX's outputs).
   */
  async cpfp(
    tenantId: string,
    batchId: string,
    targetFeeRateSatVb?: number
  ): Promise<WithdrawalBatch> {
    const batch = withdrawalBatcherService.getBatchById(tenantId, batchId);

    if (batch.status !== 'broadcast') {
      throw new ValidationError(
        `Batch ${batchId} must be in 'broadcast' status for CPFP (got '${batch.status}')`
      );
    }
    if (!batch.tx_hash) {
      throw new ValidationError(`Batch ${batchId} has no tx_hash — cannot create CPFP`);
    }

    const batchConfig = withdrawalBatcherService.getBatchConfig(tenantId);
    if (!batchConfig.btc_cpfp_enabled) {
      throw new ValidationError('CPFP is disabled — enable btcCpfpEnabled in tenant batch config');
    }

    const db = getDb();
    const now = new Date().toISOString();

    // Find the unspent change output of the parent TX in cached_utxos
    const changeUtxo = db.prepare(`
      SELECT tx_hash, vout, amount_raw
      FROM cached_utxos
      WHERE tenant_id = ? AND tx_hash = ? AND is_spent = 0 AND is_locked = 0
        AND wallet_role = 'tenant_hot'
      LIMIT 1
    `).get(tenantId, batch.tx_hash) as { tx_hash: string; vout: number; amount_raw: string } | undefined;

    if (!changeUtxo) {
      throw new ValidationError(
        `No spendable change output found for parent TX ${batch.tx_hash}. ` +
        'The node may not have indexed the UTXO yet — retry after mempool sync.'
      );
    }

    const parentFeeRate = batch.fee_rate_sat_vb ? parseFloat(batch.fee_rate_sat_vb) : 1;
    const effectiveFeeRateSatVb = targetFeeRateSatVb ?? Math.ceil(parentFeeRate * 2);

    if (effectiveFeeRateSatVb > batchConfig.btc_max_fee_rate_sat_vb) {
      throw new ValidationError(
        `Target fee rate (${effectiveFeeRateSatVb} sat/vb) exceeds tenant max (${batchConfig.btc_max_fee_rate_sat_vb} sat/vb)`
      );
    }

    const changeAddrRow = db.prepare(`
      SELECT a.address FROM addresses a JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
      LIMIT 1
    `).get(tenantId) as { address: string } | undefined;

    if (!changeAddrRow) {
      throw new ValidationError('No tenant hot wallet address available for CPFP output');
    }

    const changeAmount = BigInt(changeUtxo.amount_raw);
    // ~82 vbytes for a single-input single-output P2WPKH TX
    const cpfpVsize = 82n;
    const cpfpFee = BigInt(effectiveFeeRateSatVb) * cpfpVsize;

    if (cpfpFee >= changeAmount) {
      throw new ValidationError(
        `CPFP fee (${cpfpFee} sats) would exceed the change output (${changeAmount} sats). ` +
        'Lower targetFeeRateSatVb or the change output is too small.'
      );
    }

    const cpfpOutput = changeAmount - cpfpFee;
    const cpfpBatchId = `wdb_${crypto.randomBytes(8).toString('hex')}`;

    db.prepare(`
      INSERT INTO withdrawal_batches (
        id, tenant_id, chain_id, asset_id,
        status, outputs_count, total_output_raw, fee_rate_sat_vb, fee_raw,
        rbf_enabled, replacement_of_batch_id, decision_mode, attempt_count, created_at, updated_at
      ) VALUES (?, ?, 'bitcoin', 'bitcoin:BTC', 'building', 1, ?, ?, ?, 1, ?, 'auto', 0, ?, ?)
    `).run(
      cpfpBatchId, tenantId,
      cpfpOutput.toString(), effectiveFeeRateSatVb.toString(), cpfpFee.toString(),
      batchId, now, now
    );

    // Atomically lock the change UTXO
    const lockResult = db.prepare(`
      UPDATE cached_utxos SET is_locked = 1
      WHERE tenant_id = ? AND tx_hash = ? AND vout = ? AND is_locked = 0 AND is_spent = 0
    `).run(tenantId, changeUtxo.tx_hash, changeUtxo.vout);

    if (lockResult.changes === 0) {
      db.prepare('DELETE FROM withdrawal_batches WHERE id = ?').run(cpfpBatchId);
      throw new ValidationError(
        `Change UTXO ${changeUtxo.tx_hash}:${changeUtxo.vout} was concurrently locked`
      );
    }

    const lockId = `ulk_${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(`
      INSERT INTO utxo_locks (id, tenant_id, batch_id, chain_id, tx_hash, vout, amount_raw, status, locked_at, expires_at)
      VALUES (?, ?, ?, 'bitcoin', ?, ?, ?, 'locked', ?, ?)
    `).run(
      lockId, tenantId, cpfpBatchId,
      changeUtxo.tx_hash, changeUtxo.vout, changeUtxo.amount_raw,
      now, new Date(Date.now() + 15 * 60 * 1000).toISOString()
    );

    // Build CPFP PSBT: spend change → same change address
    const adapter = new BitcoinAdapter();
    let psbtBase64: string;

    try {
      const psbtResult = await adapter.walletCreateFundedPsbt(
        [{ txid: changeUtxo.tx_hash, vout: changeUtxo.vout }],
        [{ [changeAddrRow.address]: Number(cpfpOutput) / 1e8 }],
        { feeRate: effectiveFeeRateSatVb / 1e5, changeAddress: changeAddrRow.address },
        tenantId,
      );
      psbtBase64 = psbtResult.psbt;
    } catch (err: any) {
      db.prepare(`UPDATE cached_utxos SET is_locked = 0 WHERE tenant_id = ? AND tx_hash = ? AND vout = ?`)
        .run(tenantId, changeUtxo.tx_hash, changeUtxo.vout);
      db.prepare(`UPDATE utxo_locks SET status = 'released', released_at = ? WHERE id = ?`).run(now, lockId);
      db.prepare('DELETE FROM withdrawal_batches WHERE id = ?').run(cpfpBatchId);
      throw new UnprocessableEntityError(`Failed to build CPFP PSBT: ${err.message}`);
    }

    db.prepare(`
      UPDATE withdrawal_batches SET psbt = ?, status = 'pending_signature', updated_at = ? WHERE id = ?
    `).run(psbtBase64, now, cpfpBatchId);

    const selectedSigner = externalSignersService.selectSigner(tenantId, 'bitcoin', 'bitcoin:BTC', 'btc_psbt');
    const signingTask = signingTasksService.create({
      tenantId,
      signerId: selectedSigner?.id ?? null,
      requestType: 'btc_withdrawal_batch',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      withdrawalBatchId: cpfpBatchId,
      amountRaw: cpfpOutput.toString(),
      feeRaw: cpfpFee.toString(),
      feeRateSatVb: effectiveFeeRateSatVb.toString(),
      outputsCount: 1,
      payloadFormat: 'btc_psbt',
      unsignedPayload: psbtBase64,
      decisionMode: 'auto',
      decisionReason: `CPFP fee bump for parent batch ${batchId} at ${effectiveFeeRateSatVb} sat/vb`,
    });

    db.prepare(`UPDATE withdrawal_batches SET signing_task_id = ?, signer_id = ?, updated_at = ? WHERE id = ?`)
      .run(signingTask.id, selectedSigner?.id ?? null, now, cpfpBatchId);

    logger.info('CPFP batch created', { parentBatchId: batchId, cpfpBatchId, tenantId, effectiveFeeRateSatVb });
    return withdrawalBatcherService.getBatchById(tenantId, cpfpBatchId);
  },
};
