import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ConflictError } from '../../shared/errors/index';
import { addSatoshi } from '../../shared/money/index';
import { toUnixTs } from '../../shared/time/index';
import { ledgerService } from '../ledger/ledger.service';
import { customersAmlKycService } from './customers-aml-kyc.service';
import { customersDataGovernanceService } from './customers-data-governance.service';
import { Customer, CustomerBalance, PartyType, PartyStatus } from './customers.types';
import { AccessFilter } from '../../shared/actor-auth/types';
import { SecuredQuery } from '../../shared/actor-auth/query';
import { normalizeSort, sortToOrderBy, encodeCursor, decodeCursor, cursorToSql } from '../../shared/actor-auth/sort';
import { CustomerEntityDef } from '../../shared/actor-auth/entity-defs';

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

function wildcardToLike(term: string): string {
  return term.includes('*') ? term.replace(/\*/g, '%') : `%${term}%`;
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
      ownerUserId?: string | null;
      ownerTeamId?: string | null;
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
         status, metadata, owner_user_id, owner_team_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(
      id,
      tenantId,
      input.reference ?? null,
      input.party_type ?? 'natural_person',
      input.display_name ?? null,
      input.country_of_origin ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.ownerUserId ?? null,
      input.ownerTeamId ?? null,
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

    // getById without access filter — we just created it, always visible
    return customersService.getById(tenantId, id);
  },

  list(
    tenantId: string,
    filters: {
      limit?: number;
      cursor?: string;
      sort?: string;
      // customers table
      status?: string;
      party_type?: PartyType;
      id?: string;
      reference?: string;
      display_name?: string;
      country_of_origin?: string;
      // customer_profiles (EXISTS)
      profile_given_name?: string;
      profile_family_name?: string;
      profile_middle_name?: string;
      profile_business_name?: string;
      // customer_contact (EXISTS)
      contact_email?: string;
      contact_phone?: string;
      // customer_identifiers (EXISTS)
      identifier_type?: string;
      identifier_value?: string;
      // customer_relationships external_party JSON (EXISTS)
      rel_display_name?: string;
      rel_identifier_type?: string;
      rel_identifier_value?: string;
    } = {},
    accessFilter?: AccessFilter
  ): { data: Customer[]; nextCursor: string | null } {
    const db = getDb();
    const filter: AccessFilter = accessFilter ?? { type: 'all', tenantId };
    const sq = SecuredQuery.for(filter, 'c');

    if (sq.isDenied) return { data: [], nextCursor: null };

    const limit = Math.min(filters.limit ?? 20, 100);
    const sort = normalizeSort(filters.sort, CustomerEntityDef.sortPolicy);

    const params: unknown[] = [...sq.fragment.params];
    let query = `SELECT * FROM customers c WHERE 1=1 ${sq.fragment.sql}`;

    // --- customers table filters ---
    if (filters.status)           { query += ' AND c.status = ?';           params.push(filters.status); }
    if (filters.party_type)       { query += ' AND c.party_type = ?';       params.push(filters.party_type); }
    if (filters.id)               { query += ' AND c.id = ?';               params.push(filters.id); }
    if (filters.reference)        { query += ' AND c.reference LIKE ?';     params.push(wildcardToLike(filters.reference)); }
    if (filters.display_name)     { query += ' AND c.display_name LIKE ?';  params.push(wildcardToLike(filters.display_name)); }
    if (filters.country_of_origin){ query += ' AND c.country_of_origin = ?'; params.push(filters.country_of_origin.toUpperCase()); }

    // --- customer_profiles (1:1, EXISTS) ---
    const profileClauses: string[] = [];
    const profileParams: unknown[] = [];
    if (filters.profile_given_name)   { profileClauses.push('cp.given_name LIKE ?');  profileParams.push(wildcardToLike(filters.profile_given_name)); }
    if (filters.profile_family_name)  { profileClauses.push('cp.family_name LIKE ?'); profileParams.push(wildcardToLike(filters.profile_family_name)); }
    if (filters.profile_middle_name)  { profileClauses.push('cp.middle_name LIKE ?'); profileParams.push(wildcardToLike(filters.profile_middle_name)); }
    if (filters.profile_business_name) {
      profileClauses.push('(cp.business_name LIKE ? OR cp.legal_name LIKE ?)');
      profileParams.push(wildcardToLike(filters.profile_business_name), wildcardToLike(filters.profile_business_name));
    }
    if (profileClauses.length > 0) {
      query += ` AND EXISTS (SELECT 1 FROM customer_profiles cp WHERE cp.customer_id = c.id AND ${profileClauses.join(' AND ')})`;
      params.push(...profileParams);
    }

    // --- customer_contact (1:1, EXISTS) ---
    const contactClauses: string[] = [];
    const contactParams: unknown[] = [];
    if (filters.contact_email) { contactClauses.push('cc.email LIKE ?'); contactParams.push(wildcardToLike(filters.contact_email)); }
    if (filters.contact_phone) { contactClauses.push('cc.phone LIKE ?'); contactParams.push(wildcardToLike(filters.contact_phone)); }
    if (contactClauses.length > 0) {
      query += ` AND EXISTS (SELECT 1 FROM customer_contact cc WHERE cc.customer_id = c.id AND ${contactClauses.join(' AND ')})`;
      params.push(...contactParams);
    }

    // --- customer_identifiers (1:many, EXISTS) ---
    const identClauses: string[] = [];
    const identParams: unknown[] = [];
    if (filters.identifier_type)  { identClauses.push('LOWER(ci.type) = ?'); identParams.push(filters.identifier_type.toLowerCase()); }
    if (filters.identifier_value) { identClauses.push('ci.value LIKE ?');    identParams.push(wildcardToLike(filters.identifier_value)); }
    if (identClauses.length > 0) {
      query += ` AND EXISTS (SELECT 1 FROM customer_identifiers ci WHERE ci.customer_id = c.id AND ${identClauses.join(' AND ')})`;
      params.push(...identParams);
    }

    // --- customer_relationships external_party JSON (1:many, EXISTS + JSON_EXTRACT) ---
    const relClauses: string[] = [];
    const relParams: unknown[] = [];
    if (filters.rel_display_name)    { relClauses.push("JSON_EXTRACT(cr.external_party, '$.display_name') LIKE ?");      relParams.push(wildcardToLike(filters.rel_display_name)); }
    if (filters.rel_identifier_type) { relClauses.push("LOWER(JSON_EXTRACT(cr.external_party, '$.identifier_type')) = ?"); relParams.push(filters.rel_identifier_type.toLowerCase()); }
    if (filters.rel_identifier_value){ relClauses.push("JSON_EXTRACT(cr.external_party, '$.identifier_value') LIKE ?");  relParams.push(wildcardToLike(filters.rel_identifier_value)); }
    if (relClauses.length > 0) {
      query += ` AND EXISTS (SELECT 1 FROM customer_relationships cr WHERE cr.customer_id = c.id AND ${relClauses.join(' AND ')})`;
      params.push(...relParams);
    }

    if (filters.cursor) {
      const actorId = filter.type === 'all' ? null : (filter as { actorId: string }).actorId;
      const decoded = decodeCursor(filters.cursor, sort, tenantId, actorId);
      const { sql: cSql, params: cParams } = cursorToSql(decoded, sort);
      query += ` ${cSql}`;
      params.push(...cParams);
    }

    query += ` ORDER BY ${sortToOrderBy(sort)} LIMIT ?`;
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastRow = items[items.length - 1];
      const actorId = filter.type === 'all' ? null : (filter as { actorId: string }).actorId;
      nextCursor = encodeCursor(lastRow, sort, tenantId, actorId);
    }

    return {
      data: items.map(mapCustomer),
      nextCursor,
    };
  },

  getById(tenantId: string, id: string, accessFilter?: AccessFilter): Customer {
    const db = getDb();

    // When no access filter supplied (internal calls, sub-resource guards with no actor),
    // fall back to tenant-only filter for backward compatibility.
    const filter: AccessFilter = accessFilter ?? { type: 'all', tenantId };
    const sq = SecuredQuery.for(filter, 'c');

    // 'deny' → same 404 as "not found" — do not reveal existence
    if (sq.isDenied) throw new NotFoundError('Customer', id);

    const row = db
      .prepare(`SELECT * FROM customers c WHERE c.id = ? ${sq.fragment.sql}`)
      .get(id, ...sq.fragment.params);
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
    },
    accessFilter?: AccessFilter
  ): Customer {
    const db = getDb();
    const filter: AccessFilter = accessFilter ?? { type: 'all', tenantId };
    const sq = SecuredQuery.for(filter, 'c');

    // 404 guard with access filter (deny → 404)
    if (sq.isDenied) throw new NotFoundError('Customer', id);
    const existing = db
      .prepare(`SELECT id FROM customers c WHERE c.id = ? ${sq.fragment.sql}`)
      .get(id, ...sq.fragment.params);
    if (!existing) throw new NotFoundError('Customer', id);

    if (input.reference) {
      const dup = db
        .prepare('SELECT id FROM customers WHERE tenant_id = ? AND reference = ? AND id != ?')
        .get(tenantId, input.reference, id);
      if (dup) throw new ConflictError(`Customer with reference '${input.reference}' already exists`);
    }

    const now = new Date().toISOString();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.reference !== undefined)         { sets.push('reference = ?');         params.push(input.reference); }
    if (input.status !== undefined)            { sets.push('status = ?');            params.push(input.status); }
    if (input.display_name !== undefined)      { sets.push('display_name = ?');      params.push(input.display_name); }
    if (input.country_of_origin !== undefined) { sets.push('country_of_origin = ?'); params.push(input.country_of_origin); }
    if (input.metadata !== undefined)          { sets.push('metadata = ?');          params.push(JSON.stringify(input.metadata)); }
    if (sets.length === 0) return customersService.getById(tenantId, id);

    sets.push('updated_at = ?');
    params.push(now);

    // Access filter in the UPDATE WHERE — prevents race condition where a separate
    // SELECT check passes but the record ownership changes before UPDATE executes.
    const updateSq = SecuredQuery.for(filter, 'customers');
    db.prepare(
      `UPDATE customers SET ${sets.join(', ')} WHERE id = ? ${updateSq.fragment.sql}`
    ).run(...params, id, ...updateSq.fragment.params);

    return customersService.getById(tenantId, id);
  },

  disable(tenantId: string, id: string, accessFilter?: AccessFilter): Customer {
    return customersService.update(tenantId, id, { status: 'disabled' }, accessFilter);
  },

  getBalances(tenantId: string, customerId: string, accessFilter?: AccessFilter): CustomerBalance[] {
    customersService.getById(tenantId, customerId, accessFilter); // 404 + access guard
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
    filters: { limit?: number; cursor?: string; status?: string } = {},
    accessFilter?: AccessFilter
  ): { data: any[]; nextCursor: string | null } {
    customersService.getById(tenantId, customerId, accessFilter); // 404 + access guard
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
    filters: { limit?: number; cursor?: string } = {},
    accessFilter?: AccessFilter
  ): { data: any[]; nextCursor: string | null } {
    customersService.getById(tenantId, customerId, accessFilter); // 404 + access guard
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
