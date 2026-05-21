import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import {
  CustomerProfile,
  NaturalPersonProfile,
  LegalEntityProfile,
  PersonType,
  EntitySubtype,
  IndustryCodeType,
  Gender,
} from './customers.types';

function mapProfile(row: any, partyType: string): CustomerProfile {
  if (partyType === 'natural_person') {
    return {
      customer_id: row.customer_id,
      person_type: row.person_type,
      given_name: row.given_name,
      family_name: row.family_name,
      middle_name: row.middle_name ?? null,
      date_of_birth: row.date_of_birth ?? null,
      place_of_birth: row.place_of_birth ?? null,
      nationalities: row.nationalities ? JSON.parse(row.nationalities) : null,
      country_of_residence: row.country_of_residence ?? null,
      occupation: row.occupation ?? null,
      employer_name: row.employer_name ?? null,
      employer_country: row.employer_country ?? null,
      business_name: row.business_name ?? null,
      business_activity: row.business_activity ?? null,
      gender: row.gender ?? null,
      updated_at: row.updated_at,
    } satisfies NaturalPersonProfile;
  }

  return {
    customer_id: row.customer_id,
    entity_subtype: row.entity_subtype,
    entity_subtype_other: row.entity_subtype_other ?? null,
    legal_name: row.legal_name,
    trade_name: row.trade_name ?? null,
    country_of_incorporation: row.country_of_incorporation,
    date_of_incorporation: row.date_of_incorporation ?? null,
    legal_form: row.legal_form ?? null,
    jurisdiction: row.jurisdiction ?? null,
    industry_code: row.industry_code ?? null,
    industry_code_type: row.industry_code_type ?? null,
    purpose_statement: row.purpose_statement ?? null,
    regulated: row.regulated !== null ? Boolean(row.regulated) : null,
    regulatory_status: row.regulatory_status ?? null,
    regulatory_body: row.regulatory_body ?? null,
    regulatory_ref: row.regulatory_ref ?? null,
    is_listed_company: row.is_listed_company !== null ? Boolean(row.is_listed_company) : null,
    stock_exchange: row.stock_exchange ?? null,
    updated_at: row.updated_at,
  } satisfies LegalEntityProfile;
}

export interface UpsertNaturalPersonProfileInput {
  person_type: PersonType;
  given_name: string;
  family_name: string;
  middle_name?: string | null;
  date_of_birth?: string | null;
  place_of_birth?: string | null;
  nationalities?: string[] | null;
  country_of_residence?: string | null;
  occupation?: string | null;
  employer_name?: string | null;
  employer_country?: string | null;
  business_name?: string | null;
  business_activity?: string | null;
  gender?: Gender | null;
}

export interface UpsertLegalEntityProfileInput {
  entity_subtype: EntitySubtype;
  entity_subtype_other?: string | null;
  legal_name: string;
  trade_name?: string | null;
  country_of_incorporation: string;
  date_of_incorporation?: string | null;
  legal_form?: string | null;
  jurisdiction?: string | null;
  industry_code?: string | null;
  industry_code_type?: IndustryCodeType | null;
  purpose_statement?: string | null;
  regulated?: boolean | null;
  regulatory_status?: string | null;
  regulatory_body?: string | null;
  regulatory_ref?: string | null;
  is_listed_company?: boolean | null;
  stock_exchange?: string | null;
}

export type UpsertProfileInput =
  | ({ partyType: 'natural_person' } & UpsertNaturalPersonProfileInput)
  | ({ partyType: 'legal_entity' } & UpsertLegalEntityProfileInput);

function getPartyType(tenantId: string, customerId: string): string {
  const db = getDb();
  const row = db
    .prepare('SELECT party_type FROM customers WHERE id = ? AND tenant_id = ?')
    .get(customerId, tenantId) as { party_type: string } | undefined;
  if (!row) throw new NotFoundError('Customer', customerId);
  return row.party_type;
}

export const customersProfileService = {
  upsert(tenantId: string, customerId: string, input: UpsertProfileInput): CustomerProfile {
    const db = getDb();
    const partyType = getPartyType(tenantId, customerId);
    const now = new Date().toISOString();

    if (input.partyType !== partyType) {
      throw new Error(
        `Profile type '${input.partyType}' does not match customer party_type '${partyType}'`
      );
    }

    const existing = db
      .prepare('SELECT 1 FROM customer_profiles WHERE customer_id = ?')
      .get(customerId);

    if (partyType === 'natural_person') {
      const p = input as { partyType: 'natural_person' } & UpsertNaturalPersonProfileInput;
      if (existing) {
        db.prepare(`
          UPDATE customer_profiles SET
            person_type = ?, given_name = ?, family_name = ?, middle_name = ?,
            date_of_birth = ?, place_of_birth = ?, nationalities = ?,
            country_of_residence = ?, occupation = ?, employer_name = ?,
            employer_country = ?, business_name = ?, business_activity = ?,
            gender = ?, updated_at = ?
          WHERE customer_id = ?
        `).run(
          p.person_type, p.given_name, p.family_name, p.middle_name ?? null,
          p.date_of_birth ?? null, p.place_of_birth ?? null,
          p.nationalities ? JSON.stringify(p.nationalities) : null,
          p.country_of_residence ?? null, p.occupation ?? null,
          p.employer_name ?? null, p.employer_country ?? null,
          p.business_name ?? null, p.business_activity ?? null,
          p.gender ?? null, now, customerId
        );
      } else {
        db.prepare(`
          INSERT INTO customer_profiles (
            customer_id, person_type, given_name, family_name, middle_name,
            date_of_birth, place_of_birth, nationalities, country_of_residence,
            occupation, employer_name, employer_country, business_name,
            business_activity, gender, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          customerId, p.person_type, p.given_name, p.family_name, p.middle_name ?? null,
          p.date_of_birth ?? null, p.place_of_birth ?? null,
          p.nationalities ? JSON.stringify(p.nationalities) : null,
          p.country_of_residence ?? null, p.occupation ?? null,
          p.employer_name ?? null, p.employer_country ?? null,
          p.business_name ?? null, p.business_activity ?? null,
          p.gender ?? null, now
        );
      }
    } else {
      const p = input as { partyType: 'legal_entity' } & UpsertLegalEntityProfileInput;
      if (existing) {
        db.prepare(`
          UPDATE customer_profiles SET
            entity_subtype = ?, entity_subtype_other = ?, legal_name = ?, trade_name = ?,
            country_of_incorporation = ?, date_of_incorporation = ?, legal_form = ?,
            jurisdiction = ?, industry_code = ?, industry_code_type = ?,
            purpose_statement = ?, regulated = ?, regulatory_status = ?,
            regulatory_body = ?, regulatory_ref = ?, is_listed_company = ?,
            stock_exchange = ?, updated_at = ?
          WHERE customer_id = ?
        `).run(
          p.entity_subtype, p.entity_subtype_other ?? null, p.legal_name, p.trade_name ?? null,
          p.country_of_incorporation, p.date_of_incorporation ?? null, p.legal_form ?? null,
          p.jurisdiction ?? null, p.industry_code ?? null, p.industry_code_type ?? null,
          p.purpose_statement ?? null,
          p.regulated !== undefined && p.regulated !== null ? (p.regulated ? 1 : 0) : null,
          p.regulatory_status ?? null, p.regulatory_body ?? null, p.regulatory_ref ?? null,
          p.is_listed_company !== undefined && p.is_listed_company !== null
            ? (p.is_listed_company ? 1 : 0) : null,
          p.stock_exchange ?? null, now, customerId
        );
      } else {
        db.prepare(`
          INSERT INTO customer_profiles (
            customer_id, entity_subtype, entity_subtype_other, legal_name, trade_name,
            country_of_incorporation, date_of_incorporation, legal_form, jurisdiction,
            industry_code, industry_code_type, purpose_statement, regulated,
            regulatory_status, regulatory_body, regulatory_ref, is_listed_company,
            stock_exchange, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          customerId, p.entity_subtype, p.entity_subtype_other ?? null, p.legal_name,
          p.trade_name ?? null, p.country_of_incorporation, p.date_of_incorporation ?? null,
          p.legal_form ?? null, p.jurisdiction ?? null, p.industry_code ?? null,
          p.industry_code_type ?? null, p.purpose_statement ?? null,
          p.regulated !== undefined && p.regulated !== null ? (p.regulated ? 1 : 0) : null,
          p.regulatory_status ?? null, p.regulatory_body ?? null, p.regulatory_ref ?? null,
          p.is_listed_company !== undefined && p.is_listed_company !== null
            ? (p.is_listed_company ? 1 : 0) : null,
          p.stock_exchange ?? null, now
        );
      }
    }

    // Also sync display_name from profile into the core customers row
    if (partyType === 'natural_person') {
      const p = input as { partyType: 'natural_person' } & UpsertNaturalPersonProfileInput;
      db.prepare('UPDATE customers SET display_name = ?, updated_at = ? WHERE id = ?').run(
        `${p.given_name} ${p.family_name}`,
        now,
        customerId
      );
    } else {
      const p = input as { partyType: 'legal_entity' } & UpsertLegalEntityProfileInput;
      db.prepare('UPDATE customers SET display_name = ?, updated_at = ? WHERE id = ?').run(
        p.legal_name,
        now,
        customerId
      );
    }

    return customersProfileService.get(tenantId, customerId)!;
  },

  get(tenantId: string, customerId: string): CustomerProfile | null {
    const db = getDb();
    const partyType = getPartyType(tenantId, customerId);
    const row = db
      .prepare('SELECT * FROM customer_profiles WHERE customer_id = ?')
      .get(customerId) as any;
    if (!row) return null;
    return mapProfile(row, partyType);
  },
};
