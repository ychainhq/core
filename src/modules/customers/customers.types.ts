// ============================================================
// Enums / literal unions
// ============================================================

export type PartyType = 'natural_person' | 'legal_entity';

export type PartyStatus =
  | 'pending'
  | 'active'
  | 'restricted'
  | 'suspended'
  | 'frozen'
  | 'closed'
  | 'rejected'
  | 'disabled'; // legacy alias for 'closed' — kept for backward compatibility

export type PersonType = 'individual' | 'sole_proprietor';

export type EntitySubtype =
  | 'company'
  | 'foundation'
  | 'association'
  | 'ngo'
  | 'public_body'
  | 'trust'
  | 'other';

export type IdentifierType =
  | 'passport'
  | 'national_id'
  | 'driving_license'
  | 'social_security'
  | 'tax_id'
  | 'vat_id'
  | 'company_reg'
  | 'national_business_id'
  | 'lei'
  | 'eori'
  | 'duns'
  | 'bic'
  | 'internal'
  | 'other';

export type RelationshipType =
  | 'beneficial_owner'
  | 'control_person'
  | 'legal_representative'
  | 'authorized_signatory'
  | 'board_member'
  | 'foundation_board'
  | 'trustee'
  | 'settlor'
  | 'beneficiary'
  | 'protector'
  | 'nominee'
  | 'shareholder'
  | 'other';

export type VerificationMethod = 'document' | 'declaration' | 'registry' | 'provider';

export type KycStatus =
  | 'not_started'
  | 'in_progress'
  | 'pending_documents'
  | 'verified'
  | 'rejected'
  | 'expired'
  | 'suspended';

export type CddLevel = 'simplified' | 'standard' | 'enhanced';

export type AmlRiskLevel = 'low' | 'medium' | 'high' | 'very_high' | 'unassessed';

export type PepStatus =
  | 'not_pep'
  | 'pep'
  | 'former_pep'
  | 'pep_associate'
  | 'pep_family_member';

export type SanctionsStatus = 'clear' | 'hit' | 'potential_match' | 'whitelisted';

export type AdverseMediaStatus = 'clear' | 'flag' | 'monitoring';

export type SourceOfFunds =
  | 'salary'
  | 'business_income'
  | 'investments'
  | 'inheritance'
  | 'savings'
  | 'loan'
  | 'sale_of_assets'
  | 'gift'
  | 'other';

export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export type LawfulBasis =
  | 'contract'
  | 'legal_obligation'
  | 'vital_interests'
  | 'public_task'
  | 'legitimate_interests'
  | 'consent';

export type DocumentType =
  | 'passport'
  | 'national_id'
  | 'driving_license'
  | 'proof_of_address'
  | 'bank_statement'
  | 'company_certificate'
  | 'articles_of_association'
  | 'trust_deed'
  | 'foundation_charter'
  | 'ubo_declaration'
  | 'power_of_attorney'
  | 'tax_certificate'
  | 'financial_statements'
  | 'aml_questionnaire'
  | 'regulatory_license'
  | 'other';

export type DocumentVerificationStatus = 'pending' | 'verified' | 'rejected' | 'expired';

export type AddressType = 'registered' | 'correspondence' | 'residential' | 'operational';

export type IndustryCodeType = 'nace' | 'naics' | 'sic' | 'isic' | 'other';

export type Gender = 'male' | 'female' | 'other' | 'not_stated';

// ============================================================
// Core Party (Customer)
// ============================================================

export interface Customer {
  id: string;
  tenant_id: string;
  reference: string | null;
  party_type: PartyType;
  status: PartyStatus;
  display_name: string | null;
  country_of_origin: string | null;
  metadata: Record<string, unknown> | null;
  created_at: number; // Unix timestamp — kept for backward compatibility
  updated_at: number;
}

export interface CustomerBalance {
  asset_id: string;
  pending: string;
  settled: string;
  total: string;
}

// ============================================================
// Profile
// ============================================================

export interface NaturalPersonProfile {
  customer_id: string;
  person_type: PersonType;
  given_name: string;
  family_name: string;
  middle_name: string | null;
  date_of_birth: string | null;    // ISO 8601 date
  place_of_birth: string | null;
  nationalities: string[] | null;  // ISO 3166-1 alpha-2 array
  country_of_residence: string | null;
  occupation: string | null;
  employer_name: string | null;
  employer_country: string | null;
  business_name: string | null;
  business_activity: string | null;
  gender: Gender | null;
  updated_at: string;
}

export interface LegalEntityProfile {
  customer_id: string;
  entity_subtype: EntitySubtype;
  entity_subtype_other: string | null;
  legal_name: string;
  trade_name: string | null;
  country_of_incorporation: string;
  date_of_incorporation: string | null;
  legal_form: string | null;
  jurisdiction: string | null;
  industry_code: string | null;
  industry_code_type: IndustryCodeType | null;
  purpose_statement: string | null;
  regulated: boolean | null;
  regulatory_status: string | null;
  regulatory_body: string | null;
  regulatory_ref: string | null;
  is_listed_company: boolean | null;
  stock_exchange: string | null;
  updated_at: string;
}

export type CustomerProfile = NaturalPersonProfile | LegalEntityProfile;

// ============================================================
// Identifiers
// ============================================================

export interface CustomerIdentifier {
  id: string;
  customer_id: string;
  tenant_id: string;
  type: IdentifierType;
  subtype: string | null;
  value: string;
  issuing_country: string | null;
  issuing_authority: string | null;
  valid_from: string | null;
  valid_until: string | null;
  is_primary: boolean;
  verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Relationships
// ============================================================

export interface ExternalPartySnapshot {
  display_name: string;
  party_type: PartyType;
  country_of_origin: string;
  date_of_birth?: string | null;
  identifier_type?: string | null;
  identifier_value?: string | null;
}

export interface CustomerRelationship {
  id: string;
  customer_id: string;
  tenant_id: string;
  related_customer_id: string | null;
  external_party: ExternalPartySnapshot | null;
  relationship_type: RelationshipType;
  role_title: string | null;
  ownership_percentage: string | null;
  voting_rights_percentage: string | null;
  is_direct_ownership: boolean | null;
  valid_from: string | null;
  valid_until: string | null;
  verified: boolean;
  verified_at: string | null;
  verification_method: VerificationMethod | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// AML / KYC Profile
// ============================================================

export interface CustomerAmlKyc {
  customer_id: string;
  tenant_id: string;
  kyc_status: KycStatus;
  kyc_verified_at: string | null;
  kyc_expiry_date: string | null;
  kyc_provider: string | null;
  kyc_provider_ref: string | null;
  cdd_level: CddLevel;
  cdd_level_reason: string | null;
  cdd_approved_by: string | null;
  cdd_approved_at: string | null;
  aml_risk_level: AmlRiskLevel;
  aml_risk_score: number | null;
  aml_risk_assessed_at: string | null;
  aml_risk_reviewed_by: string | null;
  aml_risk_next_review: string | null;
  pep_status: PepStatus;
  pep_checked_at: string | null;
  pep_details: string | null;
  sanctions_status: SanctionsStatus;
  sanctions_checked_at: string | null;
  sanctions_lists: string[] | null;
  sanctions_hit_details: string | null;
  adverse_media_status: AdverseMediaStatus | null;
  adverse_media_checked_at: string | null;
  adverse_media_notes: string | null;
  source_of_funds: SourceOfFunds[] | null;
  source_of_funds_details: string | null;
  source_of_wealth: SourceOfFunds[] | null;
  source_of_wealth_details: string | null;
  expected_monthly_volume: string | null;
  expected_tx_types: string[] | null;
  last_review_date: string | null;
  next_review_date: string | null;
  updated_at: string;
}

// ============================================================
// Data Governance Profile
// ============================================================

export interface CustomerDataGovernance {
  customer_id: string;
  tenant_id: string;
  data_classification: DataClassification;
  sensitivity_labels: string[] | null;
  retention_policy_ref: string;
  retention_until: string | null;
  deletion_eligible_at: string | null;
  lawful_basis: LawfulBasis;
  lawful_basis_notes: string | null;
  consent_reference: string | null;
  erasure_requested_at: string | null;
  erasure_blocked_until: string | null;
  erasure_completed_at: string | null;
  portability_requested_at: string | null;
  masking_required: boolean;
  encryption_required: boolean;
  encryption_key_ref: string | null;
  source_system: string | null;
  source_system_id: string | null;
  created_by: string | null;
  last_modified_by: string | null;
  version: number;
  is_critical_entity: boolean | null;
  criticality_reason: string | null;
  ict_risk_class: string | null;
  updated_at: string;
}

// ============================================================
// Contact Information
// ============================================================

export interface PostalAddress {
  type: AddressType;
  line1: string;
  line2: string | null;
  city: string;
  postal_code: string | null;
  region: string | null;
  country: string; // ISO 3166-1 alpha-2
  is_primary: boolean;
  valid_from: string | null;
  valid_until: string | null;
}

export interface CustomerContact {
  customer_id: string;
  tenant_id: string;
  email: string | null;
  email_verified: boolean;
  phone: string | null;
  phone_verified: boolean;
  preferred_language: string | null;
  addresses: PostalAddress[] | null;
  updated_at: string;
}

// ============================================================
// Document References
// ============================================================

export interface CustomerDocument {
  id: string;
  customer_id: string;
  tenant_id: string;
  document_type: DocumentType;
  document_subtype: string | null;
  storage_ref: string;
  storage_system: string;
  issuing_country: string | null;
  issuing_authority: string | null;
  issued_date: string | null;
  expiry_date: string | null;
  document_number: string | null;
  linked_identifier_id: string | null;
  verification_status: DocumentVerificationStatus;
  verified_at: string | null;
  verified_by: string | null;
  rejection_reason: string | null;
  file_hash: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
}
