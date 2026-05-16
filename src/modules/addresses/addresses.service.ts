import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ValidationError, ConflictError } from '../../shared/errors/index';
import { adapterRegistry } from '../../chain-adapters/registry';
import { detectAddressType } from '../../shared/validation/bitcoin';
import { config } from '../../config/index';

export interface Address {
  id: string;
  tenant_id: string;
  wallet_id: string;
  chain_id: string;
  address: string;
  label: string | null;
  address_type: string | null;
  address_role: string | null;
  customer_id: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapAddress(row: any): Address {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

function generateAddressId(): string {
  return `addr_${crypto.randomBytes(8).toString('hex')}`;
}

export const addressesService = {
  addToWallet(tenantId: string, walletId: string, input: {
    chain: string;
    address: string;
    label?: string;
    addressType?: string;
    addressRole?: string;
    customerId?: string;
    metadata?: Record<string, unknown>;
  }): Address {
    const db = getDb();

    // Validate wallet exists and belongs to tenant
    const wallet = db.prepare('SELECT id FROM wallets WHERE id = ? AND tenant_id = ?').get(walletId, tenantId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    // Validate chain exists
    const chain = db.prepare('SELECT id FROM chains WHERE id = ?').get(input.chain);
    if (!chain) throw new NotFoundError('Chain', input.chain);

    // Validate address
    const adapter = adapterRegistry.get(input.chain);
    if (!adapter.isValidAddress(input.address)) {
      throw new ValidationError(`Invalid ${input.chain} address: ${input.address}`);
    }

    // Detect address type
    const detectedType = input.addressType ||
      (input.chain === 'bitcoin' ? detectAddressType(input.address, config.BITCOIN_NETWORK) || undefined : undefined);

    const now = new Date().toISOString();
    const id = generateAddressId();

    try {
      db.prepare(`
        INSERT INTO addresses (id, tenant_id, wallet_id, chain_id, address, label, address_type, address_role, customer_id, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        id,
        tenantId,
        walletId,
        input.chain,
        input.address,
        input.label ?? null,
        detectedType ?? null,
        input.addressRole ?? 'customer_deposit',
        input.customerId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now
      );
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint')) {
        throw new ConflictError(`Address ${input.address} already registered for chain ${input.chain}`);
      }
      throw err;
    }

    // Also add to watched_addresses if not already present
    const monitorId = `mon_${crypto.randomBytes(8).toString('hex')}`;
    try {
      db.prepare(`
        INSERT OR IGNORE INTO watched_addresses (id, tenant_id, chain_id, address, wallet_id, label, events, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '["incoming"]', 1, ?, ?)
      `).run(monitorId, tenantId, input.chain, input.address, walletId, input.label ?? null, now, now);
    } catch {
      // Non-critical — might already be watched
    }

    return addressesService.getById(tenantId, id);
  },

  listByWallet(tenantId: string, walletId: string, opts: { limit?: number; cursor?: string } = {}): {
    data: Address[];
    nextCursor: string | null;
  } {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 20, 100);
    let query = 'SELECT * FROM addresses WHERE tenant_id = ? AND wallet_id = ?';
    const params: unknown[] = [tenantId, walletId];

    if (opts.cursor) {
      query += ' AND id > ?';
      params.push(opts.cursor);
    }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapAddress),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  getById(tenantId: string, id: string): Address {
    const db = getDb();
    const row = db.prepare('SELECT * FROM addresses WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!row) throw new NotFoundError('Address', id);
    return mapAddress(row);
  },

  getByAddress(chainId: string, address: string): Address | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM addresses WHERE chain_id = ? AND address = ?').get(chainId, address);
    return row ? mapAddress(row) : null;
  },
};
