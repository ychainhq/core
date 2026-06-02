import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError, ValidationError, ConflictError } from '../../shared/errors/index';
import { adapterRegistry } from '../../chain-adapters/registry';
import { toUnixTs } from '../../shared/time/index';

export interface WatchedAddress {
  id: string;
  tenant_id: string;
  chain_id: string;
  address: string;
  wallet_id: string | null;
  label: string | null;
  events: string[];
  webhook_id: string | null;
  is_active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

function mapWatchedAddress(row: any): WatchedAddress {
  return {
    ...row,
    is_active: row.is_active === 1,
    events: row.events ? JSON.parse(row.events) : ['incoming'],
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

export const monitorsService = {
  async add(tenantId: string, input: {
    chain: string;
    address: string;
    label?: string;
    walletId?: string;
    events?: string[];
    webhookId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<WatchedAddress> {
    const db = getDbClient();

    // Validate chain
    const chain = await db.get('SELECT id FROM chains WHERE id = ?', [input.chain]);
    if (!chain) throw new NotFoundError('Chain', input.chain);

    // Validate address
    const adapter = adapterRegistry.get(input.chain);
    if (!adapter.isValidAddress(input.address)) {
      throw new ValidationError(`Invalid ${input.chain} address: ${input.address}`);
    }

    const id = `mon_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    try {
      await db.run(`
        INSERT INTO watched_addresses (id, tenant_id, chain_id, address, wallet_id, label, events, webhook_id, is_active, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `, [
        id,
        tenantId,
        input.chain,
        input.address,
        input.walletId ?? null,
        input.label ?? null,
        JSON.stringify(input.events ?? ['incoming']),
        input.webhookId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now
      ]);
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint')) {
        throw new ConflictError(`Address ${input.address} is already monitored for chain ${input.chain}`);
      }
      throw err;
    }

    return await monitorsService.getById(tenantId, id);
  },

  async list(tenantId: string, filters: {
    chain?: string;
    walletId?: string;
    isActive?: boolean;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ data: WatchedAddress[]; nextCursor: string | null }> {
    const db = getDbClient();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM watched_addresses WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.chain) {
      query += ' AND chain_id = ?';
      params.push(filters.chain);
    }
    if (filters.walletId) {
      query += ' AND wallet_id = ?';
      params.push(filters.walletId);
    }
    const isActiveFilter = filters.isActive ?? true;
    query += ' AND is_active = ?';
    params.push(isActiveFilter ? 1 : 0);
    if (filters.cursor) {
      query += ' AND id > ?';
      params.push(filters.cursor);
    }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = await db.all(query, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapWatchedAddress),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  async getById(tenantId: string, id: string): Promise<WatchedAddress> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM watched_addresses WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw new NotFoundError('Monitor', id);
    return mapWatchedAddress(row);
  },

  async deactivate(tenantId: string, id: string): Promise<WatchedAddress> {
    const db = getDbClient();
    const existing = await monitorsService.getById(tenantId, id);
    await db.run('UPDATE watched_addresses SET is_active = 0, updated_at = ? WHERE id = ? AND tenant_id = ?', [
      new Date().toISOString(),
      id,
      tenantId
    ]);
    return { ...existing, is_active: false };
  },

  /**
   * Insert OR IGNORE a watched_addresses row.
   * Used by addresses.service when registering a new address so it gets monitored
   * without duplicating business logic or throwing on conflict.
   */
  async ensureWatched(tenantId: string, input: {
    chainId: string;
    address: string;
    walletId?: string;
    label?: string;
  }): Promise<void> {
    const db = getDbClient();
    const id = `mon_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    await db.run(`
      INSERT OR IGNORE INTO watched_addresses
        (id, tenant_id, chain_id, address, wallet_id, label, events, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '["incoming"]', 1, ?, ?)
    `, [id, tenantId, input.chainId, input.address, input.walletId ?? null, input.label ?? null, now, now]);
  },

  // Used by workers — intentionally cross-tenant
  async getActiveByChain(chainId: string): Promise<WatchedAddress[]> {
    const db = getDbClient();
    const rows = await db.all(
      'SELECT * FROM watched_addresses WHERE chain_id = ? AND is_active = 1',
      [chainId]
    );
    return rows.map(mapWatchedAddress);
  },
};
