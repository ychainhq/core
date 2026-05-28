import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import { CustomerIdentifier, IdentifierType } from './customers.types';

function mapIdentifier(row: any): CustomerIdentifier {
  return {
    id: row.id,
    customer_id: row.customer_id,
    tenant_id: row.tenant_id,
    type: row.type,
    subtype: row.subtype ?? null,
    value: row.value,
    issuing_country: row.issuing_country ?? null,
    issuing_authority: row.issuing_authority ?? null,
    valid_from: row.valid_from ?? null,
    valid_until: row.valid_until ?? null,
    is_primary: Boolean(row.is_primary),
    verified: Boolean(row.verified),
    verified_at: row.verified_at ?? null,
    verified_by: row.verified_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function guardCustomer(tenantId: string, customerId: string): void {
  const db = getDb();
  const row = db
    .prepare('SELECT id FROM customers WHERE id = ? AND tenant_id = ?')
    .get(customerId, tenantId);
  if (!row) throw new NotFoundError('Customer', customerId);
}

function guardIdentifier(tenantId: string, customerId: string, identifierId: string): any {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT * FROM customer_identifiers WHERE id = ? AND customer_id = ? AND tenant_id = ?'
    )
    .get(identifierId, customerId, tenantId) as any;
  if (!row) throw new NotFoundError('CustomerIdentifier', identifierId);
  return row;
}

export interface CreateIdentifierInput {
  type: IdentifierType;
  subtype?: string | null;
  value: string;
  issuing_country?: string | null;
  issuing_authority?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  is_primary?: boolean;
  verified?: boolean;
  verified_at?: string | null;
  verified_by?: string | null;
}

export interface UpdateIdentifierInput {
  subtype?: string | null;
  value?: string;
  issuing_country?: string | null;
  issuing_authority?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  is_primary?: boolean;
  verified?: boolean;
  verified_at?: string | null;
  verified_by?: string | null;
}

export const customersIdentifiersService = {
  create(
    tenantId: string,
    customerId: string,
    input: CreateIdentifierInput
  ): CustomerIdentifier {
    const db = getDb();
    guardCustomer(tenantId, customerId);

    const id = `ident_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO customer_identifiers (
        id, customer_id, tenant_id, type, subtype, value,
        issuing_country, issuing_authority, valid_from, valid_until,
        is_primary, verified, verified_at, verified_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, customerId, tenantId, input.type, input.subtype ?? null, input.value,
      input.issuing_country ?? null, input.issuing_authority ?? null,
      input.valid_from ?? null, input.valid_until ?? null,
      input.is_primary ? 1 : 0,
      input.verified ? 1 : 0,
      input.verified_at ?? null,
      input.verified_by ?? null,
      now, now
    );

    return mapIdentifier(
      db.prepare('SELECT * FROM customer_identifiers WHERE id = ?').get(id)
    );
  },

  list(tenantId: string, customerId: string): CustomerIdentifier[] {
    const db = getDb();
    guardCustomer(tenantId, customerId);
    const rows = db
      .prepare(
        'SELECT * FROM customer_identifiers WHERE customer_id = ? AND tenant_id = ? ORDER BY created_at'
      )
      .all(customerId, tenantId) as any[];
    return rows.map(mapIdentifier);
  },

  update(
    tenantId: string,
    customerId: string,
    identifierId: string,
    input: UpdateIdentifierInput
  ): CustomerIdentifier {
    const db = getDb();
    guardIdentifier(tenantId, customerId, identifierId);

    const now = new Date().toISOString();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.subtype !== undefined)          { sets.push('subtype = ?');           params.push(input.subtype); }
    if (input.value !== undefined)            { sets.push('value = ?');             params.push(input.value); }
    if (input.issuing_country !== undefined)  { sets.push('issuing_country = ?');   params.push(input.issuing_country); }
    if (input.issuing_authority !== undefined){ sets.push('issuing_authority = ?'); params.push(input.issuing_authority); }
    if (input.valid_from !== undefined)       { sets.push('valid_from = ?');        params.push(input.valid_from); }
    if (input.valid_until !== undefined)      { sets.push('valid_until = ?');       params.push(input.valid_until); }
    if (input.is_primary !== undefined)       { sets.push('is_primary = ?');        params.push(input.is_primary ? 1 : 0); }
    if (input.verified !== undefined)         { sets.push('verified = ?');          params.push(input.verified ? 1 : 0); }
    if (input.verified_at !== undefined)      { sets.push('verified_at = ?');       params.push(input.verified_at); }
    if (input.verified_by !== undefined)      { sets.push('verified_by = ?');       params.push(input.verified_by); }

    if (sets.length === 0) {
      return mapIdentifier(guardIdentifier(tenantId, customerId, identifierId));
    }

    sets.push('updated_at = ?');
    params.push(now, identifierId, customerId, tenantId);
    db.prepare(
      `UPDATE customer_identifiers SET ${sets.join(', ')} WHERE id = ? AND customer_id = ? AND tenant_id = ?`
    ).run(...params);

    return mapIdentifier(
      db.prepare('SELECT * FROM customer_identifiers WHERE id = ?').get(identifierId)
    );
  },

  getById(tenantId: string, customerId: string, identifierId: string): CustomerIdentifier {
    return mapIdentifier(guardIdentifier(tenantId, customerId, identifierId));
  },

  delete(tenantId: string, customerId: string, identifierId: string): void {
    const db = getDb();
    guardIdentifier(tenantId, customerId, identifierId);
    db.prepare(
      'DELETE FROM customer_identifiers WHERE id = ? AND customer_id = ? AND tenant_id = ?'
    ).run(identifierId, customerId, tenantId);
  },
};
