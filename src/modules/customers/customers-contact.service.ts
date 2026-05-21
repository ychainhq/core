import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import { CustomerContact, PostalAddress } from './customers.types';

function mapContact(row: any): CustomerContact {
  return {
    customer_id: row.customer_id,
    tenant_id: row.tenant_id,
    email: row.email ?? null,
    email_verified: Boolean(row.email_verified),
    phone: row.phone ?? null,
    phone_verified: Boolean(row.phone_verified),
    preferred_language: row.preferred_language ?? null,
    addresses: row.addresses ? JSON.parse(row.addresses) : null,
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

export interface UpsertContactInput {
  email?: string | null;
  email_verified?: boolean;
  phone?: string | null;
  phone_verified?: boolean;
  preferred_language?: string | null;
  addresses?: PostalAddress[] | null;
}

export const customersContactService = {
  upsert(tenantId: string, customerId: string, input: UpsertContactInput): CustomerContact {
    const db = getDb();
    guardCustomer(tenantId, customerId);

    const existing = db
      .prepare('SELECT 1 FROM customer_contact WHERE customer_id = ?')
      .get(customerId);
    const now = new Date().toISOString();

    if (!existing) {
      db.prepare(`
        INSERT INTO customer_contact (
          customer_id, tenant_id, email, email_verified, phone, phone_verified,
          preferred_language, addresses, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        customerId, tenantId,
        input.email ?? null,
        input.email_verified ? 1 : 0,
        input.phone ?? null,
        input.phone_verified ? 1 : 0,
        input.preferred_language ?? null,
        input.addresses ? JSON.stringify(input.addresses) : null,
        now
      );
      return mapContact(
        db.prepare('SELECT * FROM customer_contact WHERE customer_id = ?').get(customerId)
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.email !== undefined)              { sets.push('email = ?');              params.push(input.email); }
    if (input.email_verified !== undefined)     { sets.push('email_verified = ?');     params.push(input.email_verified ? 1 : 0); }
    if (input.phone !== undefined)              { sets.push('phone = ?');              params.push(input.phone); }
    if (input.phone_verified !== undefined)     { sets.push('phone_verified = ?');     params.push(input.phone_verified ? 1 : 0); }
    if (input.preferred_language !== undefined) { sets.push('preferred_language = ?'); params.push(input.preferred_language); }
    if (input.addresses !== undefined) {
      sets.push('addresses = ?');
      params.push(input.addresses ? JSON.stringify(input.addresses) : null);
    }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(now, customerId);
      db.prepare(
        `UPDATE customer_contact SET ${sets.join(', ')} WHERE customer_id = ?`
      ).run(...params);
    }

    return mapContact(
      db.prepare('SELECT * FROM customer_contact WHERE customer_id = ?').get(customerId)
    );
  },

  get(tenantId: string, customerId: string): CustomerContact | null {
    const db = getDb();
    guardCustomer(tenantId, customerId);
    const row = db
      .prepare('SELECT * FROM customer_contact WHERE customer_id = ? AND tenant_id = ?')
      .get(customerId, tenantId) as any;
    if (!row) return null;
    return mapContact(row);
  },
};
