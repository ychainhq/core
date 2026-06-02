import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError } from '../../shared/errors/index';
import {
  CustomerRelationship,
  ExternalPartySnapshot,
  RelationshipType,
  VerificationMethod,
} from './customers.types';

function mapRelationship(row: any): CustomerRelationship {
  return {
    id: row.id,
    customer_id: row.customer_id,
    tenant_id: row.tenant_id,
    related_customer_id: row.related_customer_id ?? null,
    external_party: row.external_party ? JSON.parse(row.external_party) : null,
    relationship_type: row.relationship_type,
    role_title: row.role_title ?? null,
    ownership_percentage: row.ownership_percentage ?? null,
    voting_rights_percentage: row.voting_rights_percentage ?? null,
    is_direct_ownership:
      row.is_direct_ownership !== null ? Boolean(row.is_direct_ownership) : null,
    valid_from: row.valid_from ?? null,
    valid_until: row.valid_until ?? null,
    verified: Boolean(row.verified),
    verified_at: row.verified_at ?? null,
    verification_method: row.verification_method ?? null,
    notes: row.notes ?? null,
    created_at: row.created_at,
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

async function guardRelationship(tenantId: string, customerId: string, relationshipId: string): Promise<any> {
  const db = getDbClient();
  const row = await db.get<any>(
    'SELECT * FROM customer_relationships WHERE id = ? AND customer_id = ? AND tenant_id = ?',
    [relationshipId, customerId, tenantId]
  );
  if (!row) throw new NotFoundError('CustomerRelationship', relationshipId);
  return row;
}

export interface CreateRelationshipInput {
  related_customer_id?: string | null;
  external_party?: ExternalPartySnapshot | null;
  relationship_type: RelationshipType;
  role_title?: string | null;
  ownership_percentage?: string | null;
  voting_rights_percentage?: string | null;
  is_direct_ownership?: boolean | null;
  valid_from?: string | null;
  valid_until?: string | null;
  verified?: boolean;
  verified_at?: string | null;
  verification_method?: VerificationMethod | null;
  notes?: string | null;
}

export interface UpdateRelationshipInput {
  external_party?: ExternalPartySnapshot | null;
  role_title?: string | null;
  ownership_percentage?: string | null;
  voting_rights_percentage?: string | null;
  is_direct_ownership?: boolean | null;
  valid_from?: string | null;
  valid_until?: string | null;
  verified?: boolean;
  verified_at?: string | null;
  verification_method?: VerificationMethod | null;
  notes?: string | null;
}

export const customersRelationshipsService = {
  async create(
    tenantId: string,
    customerId: string,
    input: CreateRelationshipInput
  ): Promise<CustomerRelationship> {
    const db = getDbClient();
    await guardCustomer(tenantId, customerId);

    if (!input.related_customer_id && !input.external_party) {
      throw new Error(
        'Either related_customer_id or external_party must be provided'
      );
    }

    if (input.related_customer_id) {
      const related = await db.get(
        'SELECT id FROM customers WHERE id = ? AND tenant_id = ?',
        [input.related_customer_id, tenantId]
      );
      if (!related) throw new NotFoundError('Customer', input.related_customer_id);
    }

    const id = `rel_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO customer_relationships (
        id, customer_id, tenant_id, related_customer_id, external_party,
        relationship_type, role_title, ownership_percentage, voting_rights_percentage,
        is_direct_ownership, valid_from, valid_until,
        verified, verified_at, verification_method, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, customerId, tenantId,
        input.related_customer_id ?? null,
        input.external_party ? JSON.stringify(input.external_party) : null,
        input.relationship_type,
        input.role_title ?? null,
        input.ownership_percentage ?? null,
        input.voting_rights_percentage ?? null,
        input.is_direct_ownership !== undefined && input.is_direct_ownership !== null
          ? (input.is_direct_ownership ? 1 : 0) : null,
        input.valid_from ?? null,
        input.valid_until ?? null,
        input.verified ? 1 : 0,
        input.verified_at ?? null,
        input.verification_method ?? null,
        input.notes ?? null,
        now, now,
      ]
    );

    return mapRelationship(
      await db.get<any>('SELECT * FROM customer_relationships WHERE id = ?', [id])
    );
  },

  async list(tenantId: string, customerId: string): Promise<CustomerRelationship[]> {
    const db = getDbClient();
    await guardCustomer(tenantId, customerId);
    const rows = await db.all<any>(
      'SELECT * FROM customer_relationships WHERE customer_id = ? AND tenant_id = ? ORDER BY created_at',
      [customerId, tenantId]
    );
    return rows.map(mapRelationship);
  },

  async update(
    tenantId: string,
    customerId: string,
    relationshipId: string,
    input: UpdateRelationshipInput
  ): Promise<CustomerRelationship> {
    const db = getDbClient();
    await guardRelationship(tenantId, customerId, relationshipId);

    const now = new Date().toISOString();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.external_party !== undefined) {
      sets.push('external_party = ?');
      params.push(input.external_party ? JSON.stringify(input.external_party) : null);
    }
    if (input.role_title !== undefined)              { sets.push('role_title = ?');               params.push(input.role_title); }
    if (input.ownership_percentage !== undefined)    { sets.push('ownership_percentage = ?');     params.push(input.ownership_percentage); }
    if (input.voting_rights_percentage !== undefined){ sets.push('voting_rights_percentage = ?'); params.push(input.voting_rights_percentage); }
    if (input.is_direct_ownership !== undefined) {
      sets.push('is_direct_ownership = ?');
      params.push(input.is_direct_ownership !== null ? (input.is_direct_ownership ? 1 : 0) : null);
    }
    if (input.valid_from !== undefined)         { sets.push('valid_from = ?');         params.push(input.valid_from); }
    if (input.valid_until !== undefined)        { sets.push('valid_until = ?');        params.push(input.valid_until); }
    if (input.verified !== undefined)           { sets.push('verified = ?');           params.push(input.verified ? 1 : 0); }
    if (input.verified_at !== undefined)        { sets.push('verified_at = ?');        params.push(input.verified_at); }
    if (input.verification_method !== undefined){ sets.push('verification_method = ?');params.push(input.verification_method); }
    if (input.notes !== undefined)              { sets.push('notes = ?');              params.push(input.notes); }

    if (sets.length === 0) {
      return mapRelationship(await guardRelationship(tenantId, customerId, relationshipId));
    }

    sets.push('updated_at = ?');
    params.push(now, relationshipId, customerId, tenantId);
    await db.run(
      `UPDATE customer_relationships SET ${sets.join(', ')} WHERE id = ? AND customer_id = ? AND tenant_id = ?`,
      params
    );

    return mapRelationship(
      await db.get<any>('SELECT * FROM customer_relationships WHERE id = ?', [relationshipId])
    );
  },

  async getById(tenantId: string, customerId: string, relationshipId: string): Promise<CustomerRelationship> {
    return mapRelationship(await guardRelationship(tenantId, customerId, relationshipId));
  },

  async delete(tenantId: string, customerId: string, relationshipId: string): Promise<void> {
    const db = getDbClient();
    await guardRelationship(tenantId, customerId, relationshipId);
    await db.run(
      'DELETE FROM customer_relationships WHERE id = ? AND customer_id = ? AND tenant_id = ?',
      [relationshipId, customerId, tenantId]
    );
  },
};
