import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError, ValidationError } from '../../shared/errors/index';
import { toUnixTs } from '../../shared/time/index';
import { adapterRegistry } from '../../chain-adapters/registry';
import { ledgerService } from '../ledger/ledger.service';
import { logger } from '../../shared/logging/index';

// Lazy import — avoids circular dependency (tickler → sweeps → tickler)
let _ticklerService: typeof import('../../shared/tickler/tickler.service').ticklerService | null = null;
async function getTicklerService() {
  if (!_ticklerService) {
    const mod = await import('../../shared/tickler/tickler.service');
    _ticklerService = mod.ticklerService;
  }
  return _ticklerService;
}

export interface Sweep {
  id: string;
  tenant_id: string;
  chain_id: string;
  asset_id: string;
  from_addresses: string[];
  to_address: string;
  amount_raw: string;
  fee_raw: string | null;
  psbt: string | null;
  signed_psbt: string | null;
  tx_hash: string | null;
  signing_task_id: string | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function mapSweep(row: any): Sweep {
  return {
    ...row,
    from_addresses: JSON.parse(row.from_addresses),
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

export interface SweepSummary {
  chain_id: string;
  asset_id: string;
  threshold_raw: string | null;
  current_total_raw: string;
  missing_raw: string | null;
  progress_pct: number | null;
  total_deposit_addresses: number;
  addresses_with_balance: number;
  total_utxos: number | null;
  hot_wallet_address: string | null;
  pending_sweep_id: string | null;
}

export const sweepsService = {
  async create(tenantId: string, input: {
    chainId: string;
    assetId: string;
    fromAddresses: string[];
    toAddress: string;
    amountRaw: string;
    feeRaw?: string;
    psbt?: string;
  }): Promise<Sweep> {
    const db = getDbClient();
    const id = `sweep_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    await db.run(`
      INSERT INTO sweeps
        (id, tenant_id, chain_id, asset_id, from_addresses, to_address, amount_raw, fee_raw, psbt, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_signature', ?, ?)
    `, [
      id,
      tenantId,
      input.chainId,
      input.assetId,
      JSON.stringify(input.fromAddresses),
      input.toAddress,
      input.amountRaw,
      input.feeRaw ?? null,
      input.psbt ?? null,
      now,
      now,
    ]);

    return sweepsService.getByIdInternal(id);
  },

  async list(tenantId: string, filters: {
    chainId?: string;
    assetId?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ data: Sweep[]; nextCursor: string | null }> {
    const db = getDbClient();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM sweeps WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.chainId) { query += ' AND chain_id = ?'; params.push(filters.chainId); }
    if (filters.assetId) { query += ' AND asset_id = ?'; params.push(filters.assetId); }
    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = await db.all(query, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapSweep),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  async getById(tenantId: string, id: string): Promise<Sweep> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM sweeps WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw new NotFoundError('Sweep', id);
    return mapSweep(row);
  },

  async getByIdInternal(id: string): Promise<Sweep> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM sweeps WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Sweep', id);
    return mapSweep(row);
  },

  async updateStatus(id: string, status: string, extra: {
    signedPsbt?: string;
    txHash?: string;
    error?: string;
  } = {}): Promise<Sweep> {
    const db = getDbClient();
    const now = new Date().toISOString();
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, now];

    if (extra.signedPsbt !== undefined) { sets.push('signed_psbt = ?'); params.push(extra.signedPsbt); }
    if (extra.txHash !== undefined) { sets.push('tx_hash = ?'); params.push(extra.txHash); }
    if (extra.error !== undefined) { sets.push('error = ?'); params.push(extra.error); }

    params.push(id);
    await db.run(`UPDATE sweeps SET ${sets.join(', ')} WHERE id = ?`, params);
    return sweepsService.getByIdInternal(id);
  },

  async linkSigningTask(sweepId: string, taskId: string): Promise<void> {
    const db = getDbClient();
    const now = new Date().toISOString();
    await db.run('UPDATE sweeps SET signing_task_id = ?, updated_at = ? WHERE id = ?', [taskId, now, sweepId]);
  },

  async clearSigningTask(sweepId: string): Promise<void> {
    const db = getDbClient();
    const now = new Date().toISOString();
    await db.run('UPDATE sweeps SET signing_task_id = NULL, updated_at = ? WHERE id = ?', [now, sweepId]);
  },

  async finalizeSweepFromSigningTask(
    tenantId: string,
    sweepId: string,
    signedPsbt: string
  ): Promise<Sweep> {
    const sweep = await sweepsService.getById(tenantId, sweepId);

    if (sweep.status !== 'pending_signature') {
      throw new ValidationError(
        `Sweep ${sweepId} is in status '${sweep.status}', expected 'pending_signature'`
      );
    }

    const adapter = adapterRegistry.get(sweep.chain_id);
    let txHash: string;
    try {
      if (sweep.chain_id === 'bitcoin') {
        // BTC: finalize PSBT then broadcast hex
        const finalizedResult = await adapter.finalizePsbt(signedPsbt);
        if (!finalizedResult.complete) {
          throw new Error('PSBT is not fully signed — missing signatures');
        }
        txHash = await adapter.sendRawTransaction(finalizedResult.hex);
      } else {
        // TRON (and future chains): signed payload is directly broadcastable
        txHash = await adapter.sendRawTransaction(signedPsbt);
      }
    } catch (err: any) {
      await sweepsService.updateStatus(sweepId, 'failed', { error: String(err) });
      throw err;
    }

    const updated = await sweepsService.updateStatus(sweepId, 'broadcast', { signedPsbt, txHash });

    const sitAccount = await ledgerService.findAccountByTenantAndType(tenantId, 'sweep_in_transit');
    if (sitAccount) {
      ledgerService.addEntry({
        ledgerAccountId: sitAccount.id,
        type: 'sweep_broadcast',
        amountRaw: sweep.amount_raw,
        referenceType: 'sweep',
        referenceId: sweep.id,
      });
    }

    // Tickler obowiązkowy — ta ścieżka omija router (auto-finalize przez signing task)
    const tickler = await getTicklerService();
    tickler.record({
      tenantId,
      category: 'sweep',
      subcategory: 'signed_submitted',
      entityId: sweepId,
      actorLogin: 'system:signing-task',
      field1: txHash,
      field2: updated.status,
      newValue: updated,
    });

    logger.info('Sweep auto-finalized via signing task', { sweepId, txHash, chainId: sweep.chain_id, tenantId });
    return updated;
  },

  async submitSigned(tenantId: string, sweepId: string, signedPsbt: string): Promise<Sweep> {
    const sweep = await sweepsService.getById(tenantId, sweepId);

    if (sweep.status !== 'pending_signature') {
      throw new ValidationError(`Sweep is in status '${sweep.status}', expected 'pending_signature'`);
    }

    const adapter = adapterRegistry.get(sweep.chain_id);
    let txHash: string;
    try {
      if (sweep.chain_id === 'bitcoin') {
        // BTC: finalize PSBT then broadcast hex
        const finalizedResult = await adapter.finalizePsbt(signedPsbt);
        if (!finalizedResult.complete) {
          throw new Error('PSBT is not fully signed — missing signatures');
        }
        txHash = await adapter.sendRawTransaction(finalizedResult.hex);
      } else {
        // TRON (and future chains): signed payload is directly broadcastable
        txHash = await adapter.sendRawTransaction(signedPsbt);
      }
    } catch (err: any) {
      await sweepsService.updateStatus(sweep.id, 'failed', { error: String(err) });
      throw new ValidationError(`Failed to broadcast sweep: ${err.message ?? err}`);
    }

    const updated = await sweepsService.updateStatus(sweep.id, 'broadcast', { signedPsbt, txHash });

    const sitAccount = await ledgerService.findAccountByTenantAndType(tenantId, 'sweep_in_transit');
    if (sitAccount) {
      ledgerService.addEntry({
        ledgerAccountId: sitAccount.id,
        type: 'sweep_broadcast',
        amountRaw: sweep.amount_raw,
        referenceType: 'sweep',
        referenceId: sweep.id,
      });
    }

    logger.info('Sweep broadcast', { sweepId: sweep.id, txHash, tenantId });
    return updated;
  },

  /**
   * Find pending sweeps for a tenant (pending_signature = waiting for tenant to sign).
   */
  async getPendingForTenant(tenantId: string): Promise<Sweep[]> {
    const db = getDbClient();
    const rows = await db.all(
      "SELECT * FROM sweeps WHERE tenant_id = ? AND status = 'pending_signature'",
      [tenantId]
    );
    return rows.map(mapSweep);
  },

  async getSummary(tenantId: string, chainId = 'bitcoin', assetId = 'bitcoin:BTC'): Promise<SweepSummary> {
    if (chainId === 'bitcoin') return sweepsService._getBitcoinSummary(tenantId);
    if (chainId === 'tron') return sweepsService._getTronSummary(tenantId, assetId);
    throw new ValidationError(`Unsupported chainId for sweep summary: ${chainId}`);
  },

  async _getBitcoinSummary(tenantId: string): Promise<SweepSummary> {
    const db = getDbClient();

    const configRow = await db.get<{ btc_sweep_threshold_sats: string | null }>(
      'SELECT btc_sweep_threshold_sats FROM tenant_configs WHERE tenant_id = ?',
      [tenantId]
    );
    const thresholdRaw = configRow?.btc_sweep_threshold_sats ?? null;

    const addrRow = await db.get<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'customer_deposits'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
    `, [tenantId]);

    const utxoRow = await db.get<{ total_raw: number; addrs_with_bal: number; utxo_count: number }>(`
      SELECT
        COALESCE(SUM(CAST(amount_raw AS BIGINT)), 0) AS total_raw,
        COUNT(DISTINCT address)                        AS addrs_with_bal,
        COUNT(*)                                       AS utxo_count
      FROM cached_utxos
      WHERE tenant_id = ? AND wallet_role = 'customer_deposits'
        AND is_spent = 0 AND is_locked = 0
    `, [tenantId]);

    const currentRaw = BigInt(utxoRow!.total_raw);
    let missingRaw: string | null = null;
    let progressPct: number | null = null;

    if (thresholdRaw) {
      const threshold = BigInt(thresholdRaw);
      const missing = threshold > currentRaw ? threshold - currentRaw : BigInt(0);
      missingRaw = missing.toString();
      progressPct = threshold > BigInt(0)
        ? Math.min(100, Number((currentRaw * BigInt(100)) / threshold))
        : 0;
    }

    const hotRow = await db.get<{ address: string }>(`
      SELECT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
      LIMIT 1
    `, [tenantId]);

    const pendingRow = await db.get<{ id: string }>(
      "SELECT id FROM sweeps WHERE tenant_id = ? AND chain_id = 'bitcoin' AND status = 'pending_signature' LIMIT 1",
      [tenantId]
    );

    return {
      chain_id: 'bitcoin',
      asset_id: 'bitcoin:BTC',
      threshold_raw: thresholdRaw,
      current_total_raw: currentRaw.toString(),
      missing_raw: missingRaw,
      progress_pct: progressPct,
      total_deposit_addresses: addrRow!.cnt,
      addresses_with_balance: utxoRow!.addrs_with_bal,
      total_utxos: utxoRow!.utxo_count,
      hot_wallet_address: hotRow?.address ?? null,
      pending_sweep_id: pendingRow?.id ?? null,
    };
  },

  async _getTronSummary(tenantId: string, assetId: string): Promise<SweepSummary> {
    const db = getDbClient();

    const configRow = await db.get<{ tron_sweep_threshold_sun: string | null }>(
      'SELECT tron_sweep_threshold_sun FROM tenant_configs WHERE tenant_id = ?',
      [tenantId]
    );
    // threshold only for TRX; USDT has no per-tenant threshold column yet
    const thresholdRaw = assetId === 'tron:TRX' ? (configRow?.tron_sweep_threshold_sun ?? null) : null;

    const addrRow = await db.get<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'customer_deposits'
        AND a.chain_id = 'tron' AND a.status = 'active'
    `, [tenantId]);

    const balRow = await db.get<{ total_raw: number; addrs_with_bal: number }>(`
      SELECT
        COALESCE(SUM(CAST(tab.balance_raw AS BIGINT)), 0) AS total_raw,
        COUNT(DISTINCT tab.address)                        AS addrs_with_bal
      FROM tron_account_balances tab
      JOIN addresses a ON a.address = tab.address
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'customer_deposits'
        AND tab.asset_id = ?
        AND tab.balance_raw != '0'
    `, [tenantId, assetId]);

    const currentRaw = BigInt(balRow!.total_raw);
    let missingRaw: string | null = null;
    let progressPct: number | null = null;

    if (thresholdRaw) {
      const threshold = BigInt(thresholdRaw);
      const missing = threshold > currentRaw ? threshold - currentRaw : BigInt(0);
      missingRaw = missing.toString();
      progressPct = threshold > BigInt(0)
        ? Math.min(100, Number((currentRaw * BigInt(100)) / threshold))
        : 0;
    }

    const hotRow = await db.get<{ address: string }>(`
      SELECT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
        AND a.chain_id = 'tron' AND a.status = 'active'
      LIMIT 1
    `, [tenantId]);

    const pendingRow = await db.get<{ id: string }>(
      "SELECT id FROM sweeps WHERE tenant_id = ? AND chain_id = 'tron' AND asset_id = ? AND status = 'pending_signature' LIMIT 1",
      [tenantId, assetId]
    );

    return {
      chain_id: 'tron',
      asset_id: assetId,
      threshold_raw: thresholdRaw,
      current_total_raw: currentRaw.toString(),
      missing_raw: missingRaw,
      progress_pct: progressPct,
      total_deposit_addresses: addrRow!.cnt,
      addresses_with_balance: balRow!.addrs_with_bal,
      total_utxos: null,
      hot_wallet_address: hotRow?.address ?? null,
      pending_sweep_id: pendingRow?.id ?? null,
    };
  },

  /**
   * Return all broadcast sweeps that have a tx_hash (across all tenants).
   * Used by SweepConfirmationWorker to poll for on-chain confirmation.
   */
  async getBroadcastWithTxHash(): Promise<Sweep[]> {
    const db = getDbClient();
    const rows = await db.all(
      "SELECT * FROM sweeps WHERE status = 'broadcast' AND tx_hash IS NOT NULL"
    );
    return rows.map(mapSweep);
  },
};
