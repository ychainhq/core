import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import {
  CustomerDataGovernance,
  DataClassification,
  LawfulBasis,
} from './customers.types';

function mapDataGovernance(row: any): CustomerDataGovernance {
  return {
    customer_id: row.customer_id,
    tenant_id: row.tenant_id,
    data_classification: row.data_classification,
    sensitivity_labels: row.sensitivity_labels ? JSON.parse(row.sensitivity_labels) : null,
    retention_policy_ref: row.retention_policy_ref,
    retention_until: row.retention_until ?? null,
    deletion_eligible_at: row.deletion_eligible_at ?? null,
    lawful_basis: row.lawful_basis,
    lawful_basis_notes: row.lawful_basis_notes ?? null,
    consent_reference: row.consent_reference ?? null,
    erasure_requested_at: row.erasure_requested_at ?? null,
    erasure_blocked_until: row.erasure_blocked_until ?? null,
    erasure_completed_at: row.erasure_completed_at ?? null,
    portability_requested_at: row.portability_requested_at ?? null,
    masking_required: Boolean(row.masking_required),
    encryption_required: Boolean(row.encryption_required),
    encryption_key_ref: row.encryption_key_ref ?? null,
    source_system: row.source_system ?? null,
    source_system_id: row.source_system_id ?? null,
    created_by: row.created_by ?? null,
    last_modified_by: row.last_modified_by ?? null,
    version: row.version,
    is_critical_entity: row.is_critical_entity !== null ? Boolean(row.is_critical_entity) : null,
    criticality_reason: row.criticality_reason ?? null,
    ict_risk_class: row.ict_risk_class ?? null,
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

export interface UpsertDataGovernanceInput {
  data_classification?: DataClassification;
  sensitivity_labels?: string[] | null;
  retention_policy_ref?: string;
  retention_until?: string | null;
  deletion_eligible_at?: string | null;
  lawful_basis?: LawfulBasis;
  lawful_basis_notes?: string | null;
  consent_reference?: string | null;
  erasure_requested_at?: string | null;
  erasure_blocked_until?: string | null;
  erasure_completed_at?: string | null;
  portability_requested_at?: string | null;
  masking_required?: boolean;
  encryption_required?: boolean;
  encryption_key_ref?: string | null;
  source_system?: string | null;
  source_system_id?: string | null;
  created_by?: string | null;
  last_modified_by?: string | null;
  is_critical_entity?: boolean | null;
  criticality_reason?: string | null;
  ict_risk_class?: string | null;
}

export const customersDataGovernanceService = {
  // Called internally on customer creation to provision defaults.
  provision(tenantId: string, customerId: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO customer_data_governance (customer_id, tenant_id, updated_at)
      VALUES (?, ?, ?)
    `).run(customerId, tenantId, now);
  },

  upsert(
    tenantId: string,
    customerId: string,
    input: UpsertDataGovernanceInput
  ): CustomerDataGovernance {
    const db = getDb();
    guardCustomer(tenantId, customerId);

    const existing = db
      .prepare('SELECT version FROM customer_data_governance WHERE customer_id = ?')
      .get(customerId) as { version: number } | undefined;
    const now = new Date().toISOString();

    if (!existing) {
      db.prepare(
        'INSERT INTO customer_data_governance (customer_id, tenant_id, updated_at) VALUES (?, ?, ?)'
      ).run(customerId, tenantId, now);
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.data_classification !== undefined)  { sets.push('data_classification = ?');  params.push(input.data_classification); }
    if (input.sensitivity_labels !== undefined) {
      sets.push('sensitivity_labels = ?');
      params.push(input.sensitivity_labels ? JSON.stringify(input.sensitivity_labels) : null);
    }
    if (input.retention_policy_ref !== undefined) { sets.push('retention_policy_ref = ?'); params.push(input.retention_policy_ref); }
    if (input.retention_until !== undefined)      { sets.push('retention_until = ?');      params.push(input.retention_until); }
    if (input.deletion_eligible_at !== undefined) { sets.push('deletion_eligible_at = ?'); params.push(input.deletion_eligible_at); }
    if (input.lawful_basis !== undefined)         { sets.push('lawful_basis = ?');         params.push(input.lawful_basis); }
    if (input.lawful_basis_notes !== undefined)   { sets.push('lawful_basis_notes = ?');   params.push(input.lawful_basis_notes); }
    if (input.consent_reference !== undefined)    { sets.push('consent_reference = ?');    params.push(input.consent_reference); }
    if (input.erasure_requested_at !== undefined)     { sets.push('erasure_requested_at = ?');     params.push(input.erasure_requested_at); }
    if (input.erasure_blocked_until !== undefined)    { sets.push('erasure_blocked_until = ?');    params.push(input.erasure_blocked_until); }
    if (input.erasure_completed_at !== undefined)     { sets.push('erasure_completed_at = ?');     params.push(input.erasure_completed_at); }
    if (input.portability_requested_at !== undefined) { sets.push('portability_requested_at = ?'); params.push(input.portability_requested_at); }
    if (input.masking_required !== undefined)         { sets.push('masking_required = ?');         params.push(input.masking_required ? 1 : 0); }
    if (input.encryption_required !== undefined)      { sets.push('encryption_required = ?');      params.push(input.encryption_required ? 1 : 0); }
    if (input.encryption_key_ref !== undefined)       { sets.push('encryption_key_ref = ?');       params.push(input.encryption_key_ref); }
    if (input.source_system !== undefined)    { sets.push('source_system = ?');    params.push(input.source_system); }
    if (input.source_system_id !== undefined) { sets.push('source_system_id = ?'); params.push(input.source_system_id); }
    if (input.created_by !== undefined)       { sets.push('created_by = ?');       params.push(input.created_by); }
    if (input.last_modified_by !== undefined) { sets.push('last_modified_by = ?'); params.push(input.last_modified_by); }
    if (input.is_critical_entity !== undefined) {
      sets.push('is_critical_entity = ?');
      params.push(input.is_critical_entity !== null ? (input.is_critical_entity ? 1 : 0) : null);
    }
    if (input.criticality_reason !== undefined) { sets.push('criticality_reason = ?'); params.push(input.criticality_reason); }
    if (input.ict_risk_class !== undefined)     { sets.push('ict_risk_class = ?');     params.push(input.ict_risk_class); }

    // Always bump the version counter on any write
    const newVersion = (existing?.version ?? 0) + 1;
    sets.push('version = ?', 'updated_at = ?');
    params.push(newVersion, now, customerId);

    db.prepare(
      `UPDATE customer_data_governance SET ${sets.join(', ')} WHERE customer_id = ?`
    ).run(...params);

    return mapDataGovernance(
      db.prepare('SELECT * FROM customer_data_governance WHERE customer_id = ?').get(customerId)
    );
  },

  get(tenantId: string, customerId: string): CustomerDataGovernance | null {
    const db = getDb();
    guardCustomer(tenantId, customerId);
    const row = db
      .prepare('SELECT * FROM customer_data_governance WHERE customer_id = ? AND tenant_id = ?')
      .get(customerId, tenantId) as any;
    if (!row) return null;
    return mapDataGovernance(row);
  },
};
