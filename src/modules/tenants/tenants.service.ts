import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ConflictError } from '../../shared/errors/index';
import { BitcoinAdapter } from '../../chain-adapters/bitcoin/adapter';
import { logger } from '../../shared/logging/index';

export interface Tenant {
  id: string;
  name: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface TenantConfig {
  tenant_id: string;
  btc_confirmations_required: number;
  btc_finality_confirmations: number;
  custody_mode: string;
  withdrawal_mode: string;
  daily_withdrawal_limit_sats: string | null;
  per_tx_limit_sats: string | null;
  updated_at: string;
}

export interface TenantWithConfig extends Tenant {
  config: TenantConfig | null;
}

function mapTenant(row: any): Tenant {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

function mapConfig(row: any): TenantConfig {
  return { ...row };
}

function withConfig(tenant: Tenant): TenantWithConfig {
  const db = getDb();
  const cfgRow = db
    .prepare('SELECT * FROM tenant_configs WHERE tenant_id = ?')
    .get(tenant.id);
  return {
    ...tenant,
    config: cfgRow ? mapConfig(cfgRow) : null,
  };
}

export const tenantsService = {
  /**
   * Provision the Bitcoin Core watch-only wallet for a tenant.
   * Must be called after create() completes. Idempotent.
   */
  async provisionBitcoinWallet(tenantId: string): Promise<void> {
    const adapter = new BitcoinAdapter();
    try {
      await adapter.provisionTenantWallet(tenantId);
    } catch (err) {
      logger.error('Failed to provision Bitcoin Core wallet for tenant', { tenantId, err });
      throw err;
    }
  },

  create(input: { name: string; metadata?: Record<string, unknown> }): TenantWithConfig {
    const db = getDb();
    const id = `tenant_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO tenants (id, name, status, metadata, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?)
    `).run(id, input.name, input.metadata ? JSON.stringify(input.metadata) : null, now, now);

    db.prepare(`
      INSERT INTO tenant_configs (tenant_id, btc_confirmations_required, btc_finality_confirmations,
        custody_mode, withdrawal_mode, daily_withdrawal_limit_sats, per_tx_limit_sats, updated_at)
      VALUES (?, 1, 6, 'external_signer', 'external_signer', NULL, NULL, ?)
    `).run(id, now);

    return tenantsService.getById(id);
  },

  list(input: { limit?: number; cursor?: string; status?: string } = {}): {
    data: TenantWithConfig[];
    nextCursor: string | null;
  } {
    const db = getDb();
    const limit = Math.min(input.limit ?? 20, 100);
    let query = 'SELECT * FROM tenants WHERE 1=1';
    const params: unknown[] = [];

    if (input.status) { query += ' AND status = ?'; params.push(input.status); }
    if (input.cursor) { query += ' AND id > ?'; params.push(input.cursor); }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map((r) => withConfig(mapTenant(r))),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  },

  getById(id: string): TenantWithConfig {
    const db = getDb();
    const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Tenant', id);
    return withConfig(mapTenant(row));
  },

  update(
    id: string,
    input: { name?: string; status?: string; metadata?: Record<string, unknown> }
  ): TenantWithConfig {
    const db = getDb();
    tenantsService.getById(id); // 404 guard
    const now = new Date().toISOString();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name); }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status); }
    if (input.metadata !== undefined) { sets.push('metadata = ?'); params.push(JSON.stringify(input.metadata)); }
    if (sets.length === 0) return tenantsService.getById(id);

    sets.push('updated_at = ?');
    params.push(now, id);
    db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return tenantsService.getById(id);
  },

  updateConfig(
    tenantId: string,
    input: {
      btcConfirmationsRequired?: number;
      btcFinalityConfirmations?: number;
      custodyMode?: string;
      withdrawalMode?: string;
      dailyWithdrawalLimitSats?: string | null;
      perTxLimitSats?: string | null;
    }
  ): TenantConfig {
    const db = getDb();
    tenantsService.getById(tenantId); // 404 guard
    const now = new Date().toISOString();

    const existing = db
      .prepare('SELECT * FROM tenant_configs WHERE tenant_id = ?')
      .get(tenantId) as TenantConfig | undefined;

    if (!existing) {
      db.prepare(`
        INSERT INTO tenant_configs (tenant_id, btc_confirmations_required, btc_finality_confirmations,
          custody_mode, withdrawal_mode, daily_withdrawal_limit_sats, per_tx_limit_sats, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenantId,
        input.btcConfirmationsRequired ?? 1,
        input.btcFinalityConfirmations ?? 6,
        input.custodyMode ?? 'external_signer',
        input.withdrawalMode ?? 'external_signer',
        input.dailyWithdrawalLimitSats ?? null,
        input.perTxLimitSats ?? null,
        now
      );
    } else {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (input.btcConfirmationsRequired !== undefined) { sets.push('btc_confirmations_required = ?'); params.push(input.btcConfirmationsRequired); }
      if (input.btcFinalityConfirmations !== undefined) { sets.push('btc_finality_confirmations = ?'); params.push(input.btcFinalityConfirmations); }
      if (input.custodyMode !== undefined) { sets.push('custody_mode = ?'); params.push(input.custodyMode); }
      if (input.withdrawalMode !== undefined) { sets.push('withdrawal_mode = ?'); params.push(input.withdrawalMode); }
      if ('dailyWithdrawalLimitSats' in input) { sets.push('daily_withdrawal_limit_sats = ?'); params.push(input.dailyWithdrawalLimitSats ?? null); }
      if ('perTxLimitSats' in input) { sets.push('per_tx_limit_sats = ?'); params.push(input.perTxLimitSats ?? null); }

      if (sets.length > 0) {
        sets.push('updated_at = ?');
        params.push(now, tenantId);
        db.prepare(`UPDATE tenant_configs SET ${sets.join(', ')} WHERE tenant_id = ?`).run(...params);
      }
    }

    return db.prepare('SELECT * FROM tenant_configs WHERE tenant_id = ?').get(tenantId) as TenantConfig;
  },

  generateApiKey(tenantId: string, name: string): { keyId: string; rawKey: string } {
    const db = getDb();
    tenantsService.getById(tenantId); // 404 guard

    const rawKey = `cak_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyId = `apikey_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    const existing = db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(keyHash);
    if (existing) throw new ConflictError('API key collision — please retry');

    db.prepare(`
      INSERT INTO api_keys (id, tenant_id, key_hash, name, is_active, last_used_at, created_at, expires_at)
      VALUES (?, ?, ?, ?, 1, NULL, ?, NULL)
    `).run(keyId, tenantId, keyHash, name, now);

    return { keyId, rawKey };
  },
};
