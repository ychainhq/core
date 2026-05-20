import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ValidationError } from '../../shared/errors/index';
import { toUnixTs } from '../../shared/time/index';
import { adapterRegistry } from '../../chain-adapters/registry';
import { ledgerService } from '../ledger/ledger.service';
import { logger } from '../../shared/logging/index';

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

export const sweepsService = {
  create(tenantId: string, input: {
    chainId: string;
    assetId: string;
    fromAddresses: string[];
    toAddress: string;
    amountRaw: string;
    feeRaw?: string;
    psbt?: string;
  }): Sweep {
    const db = getDb();
    const id = `sweep_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO sweeps
        (id, tenant_id, chain_id, asset_id, from_addresses, to_address, amount_raw, fee_raw, psbt, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_signature', ?, ?)
    `).run(
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
      now
    );

    return sweepsService.getByIdInternal(id);
  },

  list(tenantId: string, filters: {
    status?: string;
    limit?: number;
    cursor?: string;
  } = {}): { data: Sweep[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM sweeps WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapSweep),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  },

  getById(tenantId: string, id: string): Sweep {
    const db = getDb();
    const row = db.prepare('SELECT * FROM sweeps WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!row) throw new NotFoundError('Sweep', id);
    return mapSweep(row);
  },

  getByIdInternal(id: string): Sweep {
    const db = getDb();
    const row = db.prepare('SELECT * FROM sweeps WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Sweep', id);
    return mapSweep(row);
  },

  updateStatus(id: string, status: string, extra: {
    signedPsbt?: string;
    txHash?: string;
    error?: string;
  } = {}): Sweep {
    const db = getDb();
    const now = new Date().toISOString();
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, now];

    if (extra.signedPsbt !== undefined) { sets.push('signed_psbt = ?'); params.push(extra.signedPsbt); }
    if (extra.txHash !== undefined) { sets.push('tx_hash = ?'); params.push(extra.txHash); }
    if (extra.error !== undefined) { sets.push('error = ?'); params.push(extra.error); }

    params.push(id);
    db.prepare(`UPDATE sweeps SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return sweepsService.getByIdInternal(id);
  },

  async submitSigned(tenantId: string, sweepId: string, signedPsbt: string): Promise<Sweep> {
    const sweep = sweepsService.getById(tenantId, sweepId);

    if (sweep.status !== 'pending_signature') {
      throw new ValidationError(`Sweep is in status '${sweep.status}', expected 'pending_signature'`);
    }

    const adapter = adapterRegistry.get('bitcoin');
    let txHash: string;
    try {
      const finalizedResult = await adapter.finalizePsbt(signedPsbt);
      if (!finalizedResult.complete) {
        throw new Error('PSBT is not fully signed — missing signatures');
      }
      txHash = await (adapter as any).sendRawTransaction(finalizedResult.hex);
    } catch (err: any) {
      sweepsService.updateStatus(sweep.id, 'failed', { error: String(err) });
      throw new ValidationError(`Failed to broadcast sweep: ${err.message ?? err}`);
    }

    const updated = sweepsService.updateStatus(sweep.id, 'broadcast', { signedPsbt, txHash });

    const sitAccount = ledgerService.findAccountByTenantAndType(tenantId, 'sweep_in_transit');
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
  getPendingForTenant(tenantId: string): Sweep[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM sweeps WHERE tenant_id = ? AND status = 'pending_signature'")
      .all(tenantId) as any[];
    return rows.map(mapSweep);
  },

  /**
   * Return all broadcast sweeps that have a tx_hash (across all tenants).
   * Used by SweepConfirmationWorker to poll for on-chain confirmation.
   */
  getBroadcastWithTxHash(): Sweep[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM sweeps WHERE status = 'broadcast' AND tx_hash IS NOT NULL")
      .all() as any[];
    return rows.map(mapSweep);
  },
};
