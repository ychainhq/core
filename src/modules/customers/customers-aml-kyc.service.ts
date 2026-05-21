import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import {
  CustomerAmlKyc,
  KycStatus,
  CddLevel,
  AmlRiskLevel,
  PepStatus,
  SanctionsStatus,
  AdverseMediaStatus,
  SourceOfFunds,
} from './customers.types';

function mapAmlKyc(row: any): CustomerAmlKyc {
  return {
    customer_id: row.customer_id,
    tenant_id: row.tenant_id,
    kyc_status: row.kyc_status,
    kyc_verified_at: row.kyc_verified_at ?? null,
    kyc_expiry_date: row.kyc_expiry_date ?? null,
    kyc_provider: row.kyc_provider ?? null,
    kyc_provider_ref: row.kyc_provider_ref ?? null,
    cdd_level: row.cdd_level,
    cdd_level_reason: row.cdd_level_reason ?? null,
    cdd_approved_by: row.cdd_approved_by ?? null,
    cdd_approved_at: row.cdd_approved_at ?? null,
    aml_risk_level: row.aml_risk_level,
    aml_risk_score: row.aml_risk_score ?? null,
    aml_risk_assessed_at: row.aml_risk_assessed_at ?? null,
    aml_risk_reviewed_by: row.aml_risk_reviewed_by ?? null,
    aml_risk_next_review: row.aml_risk_next_review ?? null,
    pep_status: row.pep_status,
    pep_checked_at: row.pep_checked_at ?? null,
    pep_details: row.pep_details ?? null,
    sanctions_status: row.sanctions_status,
    sanctions_checked_at: row.sanctions_checked_at ?? null,
    sanctions_lists: row.sanctions_lists ? JSON.parse(row.sanctions_lists) : null,
    sanctions_hit_details: row.sanctions_hit_details ?? null,
    adverse_media_status: row.adverse_media_status ?? null,
    adverse_media_checked_at: row.adverse_media_checked_at ?? null,
    adverse_media_notes: row.adverse_media_notes ?? null,
    source_of_funds: row.source_of_funds ? JSON.parse(row.source_of_funds) : null,
    source_of_funds_details: row.source_of_funds_details ?? null,
    source_of_wealth: row.source_of_wealth ? JSON.parse(row.source_of_wealth) : null,
    source_of_wealth_details: row.source_of_wealth_details ?? null,
    expected_monthly_volume: row.expected_monthly_volume ?? null,
    expected_tx_types: row.expected_tx_types ? JSON.parse(row.expected_tx_types) : null,
    last_review_date: row.last_review_date ?? null,
    next_review_date: row.next_review_date ?? null,
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

export interface UpsertAmlKycInput {
  kyc_status?: KycStatus;
  kyc_verified_at?: string | null;
  kyc_expiry_date?: string | null;
  kyc_provider?: string | null;
  kyc_provider_ref?: string | null;
  cdd_level?: CddLevel;
  cdd_level_reason?: string | null;
  cdd_approved_by?: string | null;
  cdd_approved_at?: string | null;
  aml_risk_level?: AmlRiskLevel;
  aml_risk_score?: number | null;
  aml_risk_assessed_at?: string | null;
  aml_risk_reviewed_by?: string | null;
  aml_risk_next_review?: string | null;
  pep_status?: PepStatus;
  pep_checked_at?: string | null;
  pep_details?: string | null;
  sanctions_status?: SanctionsStatus;
  sanctions_checked_at?: string | null;
  sanctions_lists?: string[] | null;
  sanctions_hit_details?: string | null;
  adverse_media_status?: AdverseMediaStatus | null;
  adverse_media_checked_at?: string | null;
  adverse_media_notes?: string | null;
  source_of_funds?: SourceOfFunds[] | null;
  source_of_funds_details?: string | null;
  source_of_wealth?: SourceOfFunds[] | null;
  source_of_wealth_details?: string | null;
  expected_monthly_volume?: string | null;
  expected_tx_types?: string[] | null;
  last_review_date?: string | null;
  next_review_date?: string | null;
}

export const customersAmlKycService = {
  // Called internally on customer creation to provision defaults.
  provision(tenantId: string, customerId: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO customer_aml_kyc (customer_id, tenant_id, updated_at)
      VALUES (?, ?, ?)
    `).run(customerId, tenantId, now);
  },

  upsert(tenantId: string, customerId: string, input: UpsertAmlKycInput): CustomerAmlKyc {
    const db = getDb();
    guardCustomer(tenantId, customerId);

    const existing = db
      .prepare('SELECT 1 FROM customer_aml_kyc WHERE customer_id = ?')
      .get(customerId);
    const now = new Date().toISOString();

    if (!existing) {
      db.prepare('INSERT INTO customer_aml_kyc (customer_id, tenant_id, updated_at) VALUES (?, ?, ?)')
        .run(customerId, tenantId, now);
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.kyc_status !== undefined)           { sets.push('kyc_status = ?');           params.push(input.kyc_status); }
    if (input.kyc_verified_at !== undefined)      { sets.push('kyc_verified_at = ?');      params.push(input.kyc_verified_at); }
    if (input.kyc_expiry_date !== undefined)      { sets.push('kyc_expiry_date = ?');      params.push(input.kyc_expiry_date); }
    if (input.kyc_provider !== undefined)         { sets.push('kyc_provider = ?');         params.push(input.kyc_provider); }
    if (input.kyc_provider_ref !== undefined)     { sets.push('kyc_provider_ref = ?');     params.push(input.kyc_provider_ref); }
    if (input.cdd_level !== undefined)            { sets.push('cdd_level = ?');            params.push(input.cdd_level); }
    if (input.cdd_level_reason !== undefined)     { sets.push('cdd_level_reason = ?');     params.push(input.cdd_level_reason); }
    if (input.cdd_approved_by !== undefined)      { sets.push('cdd_approved_by = ?');      params.push(input.cdd_approved_by); }
    if (input.cdd_approved_at !== undefined)      { sets.push('cdd_approved_at = ?');      params.push(input.cdd_approved_at); }
    if (input.aml_risk_level !== undefined)       { sets.push('aml_risk_level = ?');       params.push(input.aml_risk_level); }
    if (input.aml_risk_score !== undefined)       { sets.push('aml_risk_score = ?');       params.push(input.aml_risk_score); }
    if (input.aml_risk_assessed_at !== undefined) { sets.push('aml_risk_assessed_at = ?'); params.push(input.aml_risk_assessed_at); }
    if (input.aml_risk_reviewed_by !== undefined) { sets.push('aml_risk_reviewed_by = ?'); params.push(input.aml_risk_reviewed_by); }
    if (input.aml_risk_next_review !== undefined) { sets.push('aml_risk_next_review = ?'); params.push(input.aml_risk_next_review); }
    if (input.pep_status !== undefined)           { sets.push('pep_status = ?');           params.push(input.pep_status); }
    if (input.pep_checked_at !== undefined)       { sets.push('pep_checked_at = ?');       params.push(input.pep_checked_at); }
    if (input.pep_details !== undefined)          { sets.push('pep_details = ?');          params.push(input.pep_details); }
    if (input.sanctions_status !== undefined)     { sets.push('sanctions_status = ?');     params.push(input.sanctions_status); }
    if (input.sanctions_checked_at !== undefined) { sets.push('sanctions_checked_at = ?'); params.push(input.sanctions_checked_at); }
    if (input.sanctions_lists !== undefined) {
      sets.push('sanctions_lists = ?');
      params.push(input.sanctions_lists ? JSON.stringify(input.sanctions_lists) : null);
    }
    if (input.sanctions_hit_details !== undefined)    { sets.push('sanctions_hit_details = ?');    params.push(input.sanctions_hit_details); }
    if (input.adverse_media_status !== undefined)     { sets.push('adverse_media_status = ?');     params.push(input.adverse_media_status); }
    if (input.adverse_media_checked_at !== undefined) { sets.push('adverse_media_checked_at = ?'); params.push(input.adverse_media_checked_at); }
    if (input.adverse_media_notes !== undefined)      { sets.push('adverse_media_notes = ?');      params.push(input.adverse_media_notes); }
    if (input.source_of_funds !== undefined) {
      sets.push('source_of_funds = ?');
      params.push(input.source_of_funds ? JSON.stringify(input.source_of_funds) : null);
    }
    if (input.source_of_funds_details !== undefined)  { sets.push('source_of_funds_details = ?');  params.push(input.source_of_funds_details); }
    if (input.source_of_wealth !== undefined) {
      sets.push('source_of_wealth = ?');
      params.push(input.source_of_wealth ? JSON.stringify(input.source_of_wealth) : null);
    }
    if (input.source_of_wealth_details !== undefined) { sets.push('source_of_wealth_details = ?'); params.push(input.source_of_wealth_details); }
    if (input.expected_monthly_volume !== undefined)  { sets.push('expected_monthly_volume = ?');  params.push(input.expected_monthly_volume); }
    if (input.expected_tx_types !== undefined) {
      sets.push('expected_tx_types = ?');
      params.push(input.expected_tx_types ? JSON.stringify(input.expected_tx_types) : null);
    }
    if (input.last_review_date !== undefined) { sets.push('last_review_date = ?'); params.push(input.last_review_date); }
    if (input.next_review_date !== undefined) { sets.push('next_review_date = ?'); params.push(input.next_review_date); }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(now, customerId);
      db.prepare(
        `UPDATE customer_aml_kyc SET ${sets.join(', ')} WHERE customer_id = ?`
      ).run(...params);
    }

    return mapAmlKyc(
      db.prepare('SELECT * FROM customer_aml_kyc WHERE customer_id = ?').get(customerId)
    );
  },

  get(tenantId: string, customerId: string): CustomerAmlKyc | null {
    const db = getDb();
    guardCustomer(tenantId, customerId);
    const row = db
      .prepare('SELECT * FROM customer_aml_kyc WHERE customer_id = ? AND tenant_id = ?')
      .get(customerId, tenantId) as any;
    if (!row) return null;
    return mapAmlKyc(row);
  },
};
