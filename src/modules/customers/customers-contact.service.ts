import { getDbClient } from '../../db/client';
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

async function guardCustomer(tenantId: string, customerId: string): Promise<void> {
  const db = getDbClient();
  const row = await db.get(
    'SELECT id FROM customers WHERE id = ? AND tenant_id = ?',
    [customerId, tenantId]
  );
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
  async upsert(tenantId: string, customerId: string, input: UpsertContactInput): Promise<CustomerContact> {
    const db = getDbClient();
    await guardCustomer(tenantId, customerId);

    const existing = await db.get(
      'SELECT 1 FROM customer_contact WHERE customer_id = ?',
      [customerId]
    );
    const now = new Date().toISOString();

    if (!existing) {
      await db.run(
        `INSERT INTO customer_contact (
          customer_id, tenant_id, email, email_verified, phone, phone_verified,
          preferred_language, addresses, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customerId, tenantId,
          input.email ?? null,
          input.email_verified ? 1 : 0,
          input.phone ?? null,
          input.phone_verified ? 1 : 0,
          input.preferred_language ?? null,
          input.addresses ? JSON.stringify(input.addresses) : null,
          now,
        ]
      );
      return mapContact(
        await db.get<any>('SELECT * FROM customer_contact WHERE customer_id = ?', [customerId])
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
      await db.run(
        `UPDATE customer_contact SET ${sets.join(', ')} WHERE customer_id = ?`,
        params
      );
    }

    return mapContact(
      await db.get<any>('SELECT * FROM customer_contact WHERE customer_id = ?', [customerId])
    );
  },

  async get(tenantId: string, customerId: string): Promise<CustomerContact | null> {
    const db = getDbClient();
    await guardCustomer(tenantId, customerId);
    const row = await db.get<any>(
      'SELECT * FROM customer_contact WHERE customer_id = ? AND tenant_id = ?',
      [customerId, tenantId]
    );
    if (!row) return null;
    return mapContact(row);
  },
};
