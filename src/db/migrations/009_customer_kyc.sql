-- Migration 009: Customer KYC Domain Extension
-- Adds party_type, display_name, country_of_origin to the customers table.
-- Creates seven sub-resource tables that implement the Party aggregate model:
-- profiles, identifiers, relationships, aml_kyc, data_governance, contact, documents.

-- ============================================================
-- Extend customers table with Party core fields
-- ============================================================

ALTER TABLE customers ADD COLUMN party_type        TEXT NOT NULL DEFAULT 'natural_person';
ALTER TABLE customers ADD COLUMN display_name      TEXT;
ALTER TABLE customers ADD COLUMN country_of_origin TEXT;

-- ============================================================
-- Profile (one-to-one; discriminated by customers.party_type)
-- Stores either NaturalPersonProfile or LegalEntityProfile fields.
-- Columns for the non-applicable type are NULL.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_profiles (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),

  -- Natural Person
  person_type          TEXT,  -- 'individual' | 'sole_proprietor'
  given_name           TEXT,
  family_name          TEXT,
  middle_name          TEXT,
  date_of_birth        TEXT,  -- ISO 8601 date
  place_of_birth       TEXT,
  nationalities        TEXT,  -- JSON array of ISO 3166 codes
  country_of_residence TEXT,  -- ISO 3166
  occupation           TEXT,
  employer_name        TEXT,
  employer_country     TEXT,  -- ISO 3166
  business_name        TEXT,  -- sole proprietor trading name
  business_activity    TEXT,  -- NACE/NAICS or free text
  gender               TEXT,  -- 'male' | 'female' | 'other' | 'not_stated'

  -- Legal Entity
  entity_subtype       TEXT,  -- 'company' | 'foundation' | 'association' | 'ngo' | 'public_body' | 'trust' | 'other'
  entity_subtype_other TEXT,
  legal_name           TEXT,
  trade_name           TEXT,
  country_of_incorporation TEXT, -- ISO 3166
  date_of_incorporation    TEXT, -- ISO 8601 date
  legal_form           TEXT,
  jurisdiction         TEXT,
  industry_code        TEXT,
  industry_code_type   TEXT,  -- 'nace' | 'naics' | 'sic' | 'isic' | 'other'
  purpose_statement    TEXT,
  regulated            INTEGER, -- 0 | 1
  regulatory_status    TEXT,
  regulatory_body      TEXT,
  regulatory_ref       TEXT,
  is_listed_company    INTEGER, -- 0 | 1
  stock_exchange       TEXT,

  updated_at TEXT NOT NULL
);

-- ============================================================
-- Identifiers (many-to-one)
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_identifiers (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  type              TEXT NOT NULL,  -- see IdentifierType enum in types
  subtype           TEXT,           -- free text when type = 'other'
  value             TEXT NOT NULL,
  issuing_country   TEXT,           -- ISO 3166
  issuing_authority TEXT,
  valid_from        TEXT,           -- ISO 8601 date
  valid_until       TEXT,           -- ISO 8601 date; drives KYC expiry alerts
  is_primary        INTEGER NOT NULL DEFAULT 0,
  verified          INTEGER NOT NULL DEFAULT 0,
  verified_at       TEXT,
  verified_by       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cust_ident_customer ON customer_identifiers(customer_id);
CREATE INDEX IF NOT EXISTS idx_cust_ident_tenant   ON customer_identifiers(tenant_id, type);

-- ============================================================
-- Relationships / Related Parties (many-to-one)
-- Covers UBOs, trustees, representatives, signatories, board members, etc.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_relationships (
  id                       TEXT PRIMARY KEY,
  customer_id              TEXT NOT NULL REFERENCES customers(id),
  tenant_id                TEXT NOT NULL REFERENCES tenants(id),
  related_customer_id      TEXT REFERENCES customers(id), -- when related party is a registered Customer
  external_party           TEXT,  -- JSON: ExternalPartySnapshot (when not in system)
  relationship_type        TEXT NOT NULL,
  role_title               TEXT,
  ownership_percentage     TEXT,  -- TEXT for decimal precision (e.g., "25.50")
  voting_rights_percentage TEXT,
  is_direct_ownership      INTEGER, -- 0 | 1 | NULL
  valid_from               TEXT,
  valid_until              TEXT,
  verified                 INTEGER NOT NULL DEFAULT 0,
  verified_at              TEXT,
  verification_method      TEXT,  -- 'document' | 'declaration' | 'registry' | 'provider'
  notes                    TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cust_rel_customer ON customer_relationships(customer_id);
CREATE INDEX IF NOT EXISTS idx_cust_rel_tenant   ON customer_relationships(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cust_rel_type     ON customer_relationships(customer_id, relationship_type);

-- ============================================================
-- AML / KYC Profile (one-to-one)
-- Auto-provisioned with sensible defaults on customer creation.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_aml_kyc (
  customer_id          TEXT PRIMARY KEY REFERENCES customers(id),
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),

  -- KYC Verification
  kyc_status           TEXT NOT NULL DEFAULT 'not_started',
  kyc_verified_at      TEXT,
  kyc_expiry_date      TEXT,
  kyc_provider         TEXT,
  kyc_provider_ref     TEXT,

  -- Customer Due Diligence
  cdd_level            TEXT NOT NULL DEFAULT 'standard',
  cdd_level_reason     TEXT,
  cdd_approved_by      TEXT,
  cdd_approved_at      TEXT,

  -- AML Risk
  aml_risk_level       TEXT NOT NULL DEFAULT 'unassessed',
  aml_risk_score       INTEGER,
  aml_risk_assessed_at TEXT,
  aml_risk_reviewed_by TEXT,
  aml_risk_next_review TEXT,

  -- PEP Screening
  pep_status           TEXT NOT NULL DEFAULT 'not_pep',
  pep_checked_at       TEXT,
  pep_details          TEXT,

  -- Sanctions Screening
  sanctions_status      TEXT NOT NULL DEFAULT 'clear',
  sanctions_checked_at  TEXT,
  sanctions_lists       TEXT, -- JSON array of list codes e.g. ["EU","UN","OFAC"]
  sanctions_hit_details TEXT,

  -- Adverse Media
  adverse_media_status      TEXT,
  adverse_media_checked_at  TEXT,
  adverse_media_notes       TEXT,

  -- Source of Funds / Wealth
  source_of_funds         TEXT, -- JSON array of enum values
  source_of_funds_details TEXT,
  source_of_wealth        TEXT, -- JSON array
  source_of_wealth_details TEXT,
  expected_monthly_volume TEXT,
  expected_tx_types       TEXT, -- JSON array

  -- Periodic Review
  last_review_date TEXT,
  next_review_date TEXT,

  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cust_amlkyc_tenant     ON customer_aml_kyc(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cust_amlkyc_kyc_status ON customer_aml_kyc(tenant_id, kyc_status);
CREATE INDEX IF NOT EXISTS idx_cust_amlkyc_risk       ON customer_aml_kyc(tenant_id, aml_risk_level);

-- ============================================================
-- Data Governance Profile (one-to-one)
-- Auto-provisioned with compliance defaults on customer creation.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_data_governance (
  customer_id          TEXT PRIMARY KEY REFERENCES customers(id),
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),

  -- Classification
  data_classification  TEXT NOT NULL DEFAULT 'confidential',
  sensitivity_labels   TEXT, -- JSON array e.g. ["PII","FINANCIAL"]

  -- Retention
  retention_policy_ref TEXT NOT NULL DEFAULT 'AML_5Y',
  retention_until      TEXT,
  deletion_eligible_at TEXT,

  -- GDPR Lawful Basis (Art. 6)
  lawful_basis         TEXT NOT NULL DEFAULT 'legal_obligation',
  lawful_basis_notes   TEXT,
  consent_reference    TEXT,

  -- Data Subject Rights
  erasure_requested_at     TEXT,
  erasure_blocked_until    TEXT,
  erasure_completed_at     TEXT,
  portability_requested_at TEXT,

  -- Security
  masking_required      INTEGER NOT NULL DEFAULT 1,
  encryption_required   INTEGER NOT NULL DEFAULT 1,
  encryption_key_ref    TEXT,

  -- Provenance & Audit
  source_system    TEXT,
  source_system_id TEXT,
  created_by       TEXT,
  last_modified_by TEXT,
  version          INTEGER NOT NULL DEFAULT 1,

  -- DORA / NIS2
  is_critical_entity INTEGER, -- 0 | 1 | NULL
  criticality_reason TEXT,
  ict_risk_class     TEXT,

  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cust_dg_tenant ON customer_data_governance(tenant_id);

-- ============================================================
-- Contact Information (one-to-one)
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_contact (
  customer_id        TEXT PRIMARY KEY REFERENCES customers(id),
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  email              TEXT,
  email_verified     INTEGER NOT NULL DEFAULT 0,
  phone              TEXT,  -- E.164 format
  phone_verified     INTEGER NOT NULL DEFAULT 0,
  preferred_language TEXT,  -- ISO 639-1
  addresses          TEXT,  -- JSON array of PostalAddress objects
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cust_contact_tenant ON customer_contact(tenant_id);

-- ============================================================
-- Document References (many-to-one)
-- Stores pointers to documents only — no file content.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_documents (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customers(id),
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  document_type       TEXT NOT NULL,
  document_subtype    TEXT,
  storage_ref         TEXT NOT NULL,   -- opaque pointer to DMS / S3 / vault
  storage_system      TEXT NOT NULL,   -- 's3' | 'sharepoint' | 'provider:onfido' | etc.
  issuing_country     TEXT,
  issuing_authority   TEXT,
  issued_date         TEXT,            -- ISO 8601 date
  expiry_date         TEXT,            -- ISO 8601 date
  document_number     TEXT,
  linked_identifier_id TEXT REFERENCES customer_identifiers(id),
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verified_at         TEXT,
  verified_by         TEXT,
  rejection_reason    TEXT,
  file_hash           TEXT,            -- SHA-256 of file at upload (integrity only)
  uploaded_at         TEXT NOT NULL,
  uploaded_by         TEXT
);

CREATE INDEX IF NOT EXISTS idx_cust_docs_customer ON customer_documents(customer_id);
CREATE INDEX IF NOT EXISTS idx_cust_docs_tenant   ON customer_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cust_docs_type     ON customer_documents(customer_id, document_type);
