import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
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
  add(tenantId: string, input: {
    chain: string;
    address: string;
    label?: string;
    walletId?: string;
    events?: string[];
    webhookId?: string;
    metadata?: Record<string, unknown>;
  }): WatchedAddress {
    const db = getDb();

    // Validate chain
    const chain = db.prepare('SELECT id FROM chains WHERE id = ?').get(input.chain);
    if (!chain) throw new NotFoundError('Chain', input.chain);

    // Validate address
    const adapter = adapterRegistry.get(input.chain);
    if (!adapter.isValidAddress(input.address)) {
      throw new ValidationError(`Invalid ${input.chain} address: ${input.address}`);
    }

    const id = `mon_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    try {
      db.prepare(`
        INSERT INTO watched_addresses (id, tenant_id, chain_id, address, wallet_id, label, events, webhook_id, is_active, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
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
      );
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint')) {
        throw new ConflictError(`Address ${input.address} is already monitored for chain ${input.chain}`);
      }
      throw err;
    }

    return monitorsService.getById(tenantId, id);
  },

  list(tenantId: string, filters: {
    chain?: string;
    walletId?: string;
    isActive?: boolean;
    limit?: number;
    cursor?: string;
  } = {}): { data: WatchedAddress[]; nextCursor: string | null } {
    const db = getDb();
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

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapWatchedAddress),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  getById(tenantId: string, id: string): WatchedAddress {
    const db = getDb();
    const row = db.prepare('SELECT * FROM watched_addresses WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!row) throw new NotFoundError('Monitor', id);
    return mapWatchedAddress(row);
  },

  deactivate(tenantId: string, id: string): WatchedAddress {
    const db = getDb();
    const existing = monitorsService.getById(tenantId, id);
    db.prepare('UPDATE watched_addresses SET is_active = 0, updated_at = ? WHERE id = ? AND tenant_id = ?').run(
      new Date().toISOString(),
      id,
      tenantId
    );
    return { ...existing, is_active: false };
  },

  // Used by workers — intentionally cross-tenant
  getActiveByChain(chainId: string): WatchedAddress[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM watched_addresses WHERE chain_id = ? AND is_active = 1')
      .all(chainId);
    return rows.map(mapWatchedAddress);
  },
};
