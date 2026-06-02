import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError, ValidationError, ConflictError } from '../../shared/errors/index';
import { adapterRegistry } from '../../chain-adapters/registry';
import { detectAddressType } from '../../shared/validation/bitcoin';
import { config } from '../../config/index';
import { toUnixTs } from '../../shared/time/index';
import { monitorsService } from '../monitors/monitors.service';

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
  created_at: number;
  updated_at: number;
}

function mapAddress(row: any): Address {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

function generateAddressId(): string {
  return `addr_${crypto.randomBytes(8).toString('hex')}`;
}

export const addressesService = {
  async addToWallet(tenantId: string, walletId: string, input: {
    chain: string;
    address: string;
    label?: string;
    addressType?: string;
    addressRole?: string;
    customerId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Address> {
    const db = getDbClient();

    // Validate wallet exists and belongs to tenant
    const wallet = await db.get('SELECT id FROM wallets WHERE id = ? AND tenant_id = ?', [walletId, tenantId]);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    // Validate chain exists
    const chain = await db.get('SELECT id FROM chains WHERE id = ?', [input.chain]);
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
      await db.run(
        `INSERT INTO addresses (id, tenant_id, wallet_id, chain_id, address, label, address_type, address_role, customer_id, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [
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
          now,
        ]
      );
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint')) {
        throw new ConflictError(`Address ${input.address} already registered for chain ${input.chain}`);
      }
      throw err;
    }

    // Also add to watched_addresses if not already present
    try {
      monitorsService.ensureWatched(tenantId, {
        chainId: input.chain,
        address: input.address,
        walletId,
        label: input.label,
      });
    } catch {
      // Non-critical — might already be watched
    }

    return addressesService.getById(tenantId, id);
  },

  async listByWallet(tenantId: string, walletId: string, opts: { limit?: number; cursor?: string } = {}): Promise<{
    data: Address[];
    nextCursor: string | null;
  }> {
    const db = getDbClient();
    const limit = Math.min(opts.limit ?? 20, 100);
    let query = 'SELECT * FROM addresses WHERE tenant_id = ? AND wallet_id = ?';
    const params: unknown[] = [tenantId, walletId];

    if (opts.cursor) {
      query += ' AND id > ?';
      params.push(opts.cursor);
    }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = await db.all(query, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapAddress),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  async getById(tenantId: string, id: string): Promise<Address> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM addresses WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw new NotFoundError('Address', id);
    return mapAddress(row);
  },

  async getByAddress(chainId: string, address: string): Promise<Address | null> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM addresses WHERE chain_id = ? AND address = ?', [chainId, address]);
    return row ? mapAddress(row) : null;
  },

  async resolveCustomerDeposit(tenantId: string, address: string): Promise<{ isInternal: boolean; customerId: string | null }> {
    const db = getDbClient();
    const row = await db.get<{ customer_id: string }>(
      "SELECT customer_id FROM addresses WHERE address = ? AND tenant_id = ? AND address_role = 'customer_deposit' LIMIT 1",
      [address, tenantId]
    );
    return { isInternal: !!row, customerId: row?.customer_id ?? null };
  },
};
