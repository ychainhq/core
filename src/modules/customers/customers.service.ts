import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ConflictError } from '../../shared/errors/index';
import { addSatoshi } from '../../shared/money/index';
import { toUnixTs } from '../../shared/time/index';
import { ledgerService } from '../ledger/ledger.service';
import { customersAmlKycService } from './customers-aml-kyc.service';
import { customersDataGovernanceService } from './customers-data-governance.service';
import { Customer, CustomerBalance, PartyType, PartyStatus } from './customers.types';

export type { Customer, CustomerBalance } from './customers.types';

function mapCustomer(row: any): Customer {
  return {
    ...row,
    party_type: row.party_type ?? 'natural_person',
    display_name: row.display_name ?? null,
    country_of_origin: row.country_of_origin ?? null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

export const customersService = {
  create(
    tenantId: string,
    input: {
      reference?: string;
      party_type?: PartyType;
      display_name?: string | null;
      country_of_origin?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Customer {
    const db = getDb();
    const id = `cust_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    if (input.reference) {
      const dup = db
        .prepare('SELECT id FROM customers WHERE tenant_id = ? AND reference = ?')
        .get(tenantId, input.reference);
      if (dup) throw new ConflictError(`Customer with reference '${input.reference}' already exists`);
    }

    db.prepare(`
      INSERT INTO customers
        (id, tenant_id, reference, party_type, display_name, country_of_origin,
         status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      id,
      tenantId,
      input.reference ?? null,
      input.party_type ?? 'natural_person',
      input.display_name ?? null,
      input.country_of_origin ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now
    );

    // Auto-provision per-customer ledger accounts for BTC (MVP: always bitcoin:BTC)
    const chainId = 'bitcoin';
    const assetId = 'bitcoin:BTC';
    ledgerService.createAccount(tenantId, {
      customerId: id,
      chainId,
      assetId,
      accountType: 'customer_available',
      name: 'Available Balance (BTC)',
    });
    ledgerService.createAccount(tenantId, {
      customerId: id,
      chainId,
      assetId,
      accountType: 'customer_pending',
      name: 'Pending Balance (BTC)',
    });

    // Auto-provision AML/KYC and Data Governance records with sensible defaults
    customersAmlKycService.provision(tenantId, id);
    customersDataGovernanceService.provision(tenantId, id);

    return customersService.getById(tenantId, id);
  },

  list(
    tenantId: string,
    filters: {
      limit?: number;
      cursor?: string;
      status?: string;
      party_type?: PartyType;
    } = {}
  ): { data: Customer[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM customers WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.status)     { query += ' AND status = ?';     params.push(filters.status); }
    if (filters.party_type) { query += ' AND party_type = ?'; params.push(filters.party_type); }
    if (filters.cursor)     { query += ' AND id > ?';         params.push(filters.cursor); }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapCustomer),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  },

  getById(tenantId: string, id: string): Customer {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM customers WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId);
    if (!row) throw new NotFoundError('Customer', id);
    return mapCustomer(row);
  },

  getByReference(tenantId: string, reference: string): Customer {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM customers WHERE tenant_id = ? AND reference = ?')
      .get(tenantId, reference);
    if (!row) throw new NotFoundError('Customer', reference);
    return mapCustomer(row);
  },

  update(
    tenantId: string,
    id: string,
    input: {
      reference?: string;
      status?: PartyStatus;
      display_name?: string | null;
      country_of_origin?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Customer {
    const db = getDb();
    customersService.getById(tenantId, id); // 404 guard

    if (input.reference) {
      const dup = db
        .prepare('SELECT id FROM customers WHERE tenant_id = ? AND reference = ? AND id != ?')
        .get(tenantId, input.reference, id);
      if (dup) throw new ConflictError(`Customer with reference '${input.reference}' already exists`);
    }

    const now = new Date().toISOString();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.reference !== undefined)        { sets.push('reference = ?');        params.push(input.reference); }
    if (input.status !== undefined)           { sets.push('status = ?');           params.push(input.status); }
    if (input.display_name !== undefined)     { sets.push('display_name = ?');     params.push(input.display_name); }
    if (input.country_of_origin !== undefined){ sets.push('country_of_origin = ?');params.push(input.country_of_origin); }
    if (input.metadata !== undefined)         { sets.push('metadata = ?');         params.push(JSON.stringify(input.metadata)); }
    if (sets.length === 0) return customersService.getById(tenantId, id);

    sets.push('updated_at = ?');
    params.push(now, id, tenantId);
    db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
    return customersService.getById(tenantId, id);
  },

  disable(tenantId: string, id: string): Customer {
    return customersService.update(tenantId, id, { status: 'disabled' });
  },

  getBalances(tenantId: string, customerId: string): CustomerBalance[] {
    customersService.getById(tenantId, customerId); // 404 guard
    const db = getDb();

    const accounts = db
      .prepare('SELECT * FROM ledger_accounts WHERE tenant_id = ? AND customer_id = ?')
      .all(tenantId, customerId) as any[];

    const byAsset = new Map<string, { pending: string; settled: string }>();

    for (const acc of accounts) {
      const latest = db
        .prepare(
          'SELECT balance_pending_raw, balance_settled_raw FROM ledger_entries WHERE ledger_account_id = ? ORDER BY rowid DESC LIMIT 1'
        )
        .get(acc.id) as { balance_pending_raw: string; balance_settled_raw: string } | undefined;

      const pending = latest?.balance_pending_raw ?? '0';
      const settled = latest?.balance_settled_raw ?? '0';

      const existing = byAsset.get(acc.asset_id);
      if (existing) {
        byAsset.set(acc.asset_id, {
          pending: addSatoshi(existing.pending, pending),
          settled: addSatoshi(existing.settled, settled),
        });
      } else {
        byAsset.set(acc.asset_id, { pending, settled });
      }
    }

    return Array.from(byAsset.entries()).map(([asset_id, { pending, settled }]) => ({
      asset_id,
      pending,
      settled,
      total: addSatoshi(pending, settled),
    }));
  },

  getDeposits(
    tenantId: string,
    customerId: string,
    filters: { limit?: number; cursor?: string; status?: string } = {}
  ): { data: any[]; nextCursor: string | null } {
    customersService.getById(tenantId, customerId); // 404 guard
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM deposits WHERE tenant_id = ? AND customer_id = ?';
    const params: unknown[] = [tenantId, customerId];

    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.cursor) { query += ' AND id > ?';     params.push(filters.cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map((r: any) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  },

  getAddresses(
    tenantId: string,
    customerId: string,
    filters: { limit?: number; cursor?: string } = {}
  ): { data: any[]; nextCursor: string | null } {
    customersService.getById(tenantId, customerId); // 404 guard
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM addresses WHERE tenant_id = ? AND customer_id = ?';
    const params: unknown[] = [tenantId, customerId];

    if (filters.cursor) { query += ' AND id > ?'; params.push(filters.cursor); }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map((r: any) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  },
};
