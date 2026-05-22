import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { customersService } from './customers.service';
import { customersProfileService } from './customers-profile.service';
import { customersIdentifiersService } from './customers-identifiers.service';
import { customersRelationshipsService } from './customers-relationships.service';
import { customersAmlKycService } from './customers-aml-kyc.service';
import { customersDataGovernanceService } from './customers-data-governance.service';
import { customersContactService } from './customers-contact.service';
import { customersDocumentsService } from './customers-documents.service';
import { depositAddressService } from './deposit-address.service';
import { issueCustomerToken } from '../../shared/customer-auth/jwt.service';
import { tenantsService } from '../tenants/tenants.service';
import { AccessFilter } from '../../shared/actor-auth/types';
import { resolvePermission } from '../../shared/actor-auth/context';
import { buildAccessFilter, adminAllFilter } from '../../shared/actor-auth/filter';
import { ApiError } from '../../shared/errors/index';

export const customersRouter = Router();

// ============================================================
// Access filter helpers
// ============================================================

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

/**
 * Builds the access filter for a given entity action.
 * - No X-Actor-Token → full tenant access (admin all)
 * - With X-Actor-Token → RBAC rules from token
 * Throws 403 if actor has no permission at all.
 */
function getAccessFilter(req: Request, action: 'read' | 'write'): AccessFilter {
  const ctx = req.actorContext;
  if (!ctx) return adminAllFilter(tenantId(req));

  const resolved = resolvePermission(ctx, 'customer', action);
  if (resolved.level === 'none') {
    throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', `Actor lacks customer:${action} permission`);
  }
  return buildAccessFilter(resolved, ctx);
}

// ============================================================
// Shared Zod schemas
// ============================================================

const PARTY_STATUS = z.enum([
  'pending', 'active', 'restricted', 'suspended', 'frozen', 'closed', 'rejected', 'disabled',
]);
const PARTY_TYPE = z.enum(['natural_person', 'legal_entity']);

const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const listQuerySchema = paginationQuery.extend({
  // customers table
  status:           z.string().optional(),
  party_type:       PARTY_TYPE.optional(),
  sort:             z.string().optional(),
  id:               z.string().optional(),
  reference:        z.string().min(1).max(200).optional(),
  display_name:     z.string().min(1).max(200).optional(),
  country_of_origin:z.string().length(2).toUpperCase().optional(),
  // customer_profiles
  profile_given_name:   z.string().min(1).max(200).optional(),
  profile_family_name:  z.string().min(1).max(200).optional(),
  profile_middle_name:  z.string().min(1).max(200).optional(),
  profile_business_name:z.string().min(1).max(200).optional(),
  // customer_contact
  contact_email: z.string().min(1).max(500).optional(),
  contact_phone: z.string().min(1).max(50).optional(),
  // customer_identifiers
  identifier_type:  z.string().optional(),
  identifier_value: z.string().min(1).max(200).optional(),
  // customer_relationships external_party
  rel_display_name:     z.string().min(1).max(500).optional(),
  rel_identifier_type:  z.string().optional(),
  rel_identifier_value: z.string().min(1).max(200).optional(),
});

const depositsQuerySchema = paginationQuery.extend({
  status: z.string().optional(),
  depositId: z.string().min(1).max(100).optional(),
  txHash: z.string().min(1).max(200).optional(),
  address: z.string().min(1).max(200).optional(),
  assetId: z.string().min(1).max(100).optional(),
  minConfirmations: z.coerce.number().int().min(0).optional(),
  maxConfirmations: z.coerce.number().int().min(0).optional(),
});

// ============================================================
// Core Party CRUD
// ============================================================

const createSchema = z.object({
  reference:        z.string().min(1).max(200).optional(),
  party_type:       PARTY_TYPE.optional(),
  display_name:     z.string().min(1).max(500).nullish(),
  country_of_origin:z.string().length(2).toUpperCase().nullish(),
  metadata:         z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  reference:        z.string().min(1).max(200).optional(),
  status:           PARTY_STATUS.optional(),
  display_name:     z.string().min(1).max(500).nullish(),
  country_of_origin:z.string().length(2).toUpperCase().nullish(),
  metadata:         z.record(z.unknown()).optional(),
});

// POST /v1/customers
customersRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    // Require write permission to create
    getAccessFilter(req, 'write'); // throws 403 if no permission

    const body = createSchema.parse(req.body);
    const ctx = req.actorContext;
    const customer = customersService.create(tenantId(req), {
      ...body,
      ownerUserId: ctx?.actorId ?? null,
      ownerTeamId: ctx?.teams[0] ?? null,
    });
    res.status(201).json({ data: customer });
  } catch (err) { next(err); }
});

// GET /v1/customers
customersRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    const query = listQuerySchema.parse(req.query);
    const result = customersService.list(tenantId(req), query, filter);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId
customersRouter.get('/:customerId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    const customer = customersService.getById(tenantId(req), req.params['customerId']!, filter);
    res.json({ data: customer });
  } catch (err) { next(err); }
});

// PATCH /v1/customers/:customerId
customersRouter.patch('/:customerId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    const body = updateSchema.parse(req.body);
    const customer = customersService.update(tenantId(req), req.params['customerId']!, body, filter);
    res.json({ data: customer });
  } catch (err) { next(err); }
});

// POST /v1/customers/:customerId/disable
customersRouter.post('/:customerId/disable', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    const customer = customersService.disable(tenantId(req), req.params['customerId']!, filter);
    res.json({ data: customer });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/balances
customersRouter.get('/:customerId/balances', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    const balances = customersService.getBalances(tenantId(req), req.params['customerId']!, filter);
    res.json({ data: balances });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/deposits
customersRouter.get('/:customerId/deposits', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    const query = depositsQuerySchema.parse(req.query);
    const result = customersService.getDeposits(tenantId(req), req.params['customerId']!, query, filter);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/addresses
customersRouter.get('/:customerId/addresses', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    const query = paginationQuery.parse(req.query);
    const result = customersService.getAddresses(tenantId(req), req.params['customerId']!, query, filter);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) { next(err); }
});

// POST /v1/customers/:customerId/deposit-address
customersRouter.post('/:customerId/deposit-address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const result = await depositAddressService.generateForCustomer(
      tenantId(req),
      req.params['customerId']!
    );
    res.status(201).json({ data: result });
  } catch (err) { next(err); }
});

// POST /v1/customers/:customerId/sessions
customersRouter.post('/:customerId/sessions', (req: Request, res: Response, next: NextFunction) => {
  try {
    // Sessions are read-scoped — actor needs read access to this customer
    const filter = getAccessFilter(req, 'read');
    const customer = customersService.getById(tenantId(req), req.params['customerId']!, filter);
    if (customer.status !== 'active') {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: `Customer account is ${customer.status}` },
      });
      return;
    }
    const tenantWithConfig = tenantsService.getById(tenantId(req));
    const ttl = tenantWithConfig.config?.customer_session_ttl_seconds ?? undefined;
    const { accessToken, expiresAt } = issueCustomerToken(tenantId(req), customer.id, ttl);
    res.status(201).json({ data: { accessToken, expiresAt, customerId: customer.id } });
  } catch (err) { next(err); }
});

// ============================================================
// Profile
// ============================================================

const naturalPersonProfileSchema = z.object({
  partyType:            z.literal('natural_person'),
  person_type:          z.enum(['individual', 'sole_proprietor']),
  given_name:           z.string().min(1).max(200),
  family_name:          z.string().min(1).max(200),
  middle_name:          z.string().max(200).nullish(),
  date_of_birth:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  place_of_birth:       z.string().max(500).nullish(),
  nationalities:        z.array(z.string().length(2)).nullish(),
  country_of_residence: z.string().length(2).toUpperCase().nullish(),
  occupation:           z.string().max(200).nullish(),
  employer_name:        z.string().max(500).nullish(),
  employer_country:     z.string().length(2).toUpperCase().nullish(),
  business_name:        z.string().max(500).nullish(),
  business_activity:    z.string().max(200).nullish(),
  gender:               z.enum(['male', 'female', 'other', 'not_stated']).nullish(),
});

const legalEntityProfileSchema = z.object({
  partyType:               z.literal('legal_entity'),
  entity_subtype:          z.enum(['company', 'foundation', 'association', 'ngo', 'public_body', 'trust', 'other']),
  entity_subtype_other:    z.string().max(200).nullish(),
  legal_name:              z.string().min(1).max(500),
  trade_name:              z.string().max(500).nullish(),
  country_of_incorporation:z.string().length(2).toUpperCase(),
  date_of_incorporation:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  legal_form:              z.string().max(200).nullish(),
  jurisdiction:            z.string().max(200).nullish(),
  industry_code:           z.string().max(50).nullish(),
  industry_code_type:      z.enum(['nace', 'naics', 'sic', 'isic', 'other']).nullish(),
  purpose_statement:       z.string().max(2000).nullish(),
  regulated:               z.boolean().nullish(),
  regulatory_status:       z.string().max(500).nullish(),
  regulatory_body:         z.string().max(500).nullish(),
  regulatory_ref:          z.string().max(200).nullish(),
  is_listed_company:       z.boolean().nullish(),
  stock_exchange:          z.string().max(200).nullish(),
});

const upsertProfileSchema = z.discriminatedUnion('partyType', [
  naturalPersonProfileSchema,
  legalEntityProfileSchema,
]);

// PUT /v1/customers/:customerId/profile
customersRouter.put('/:customerId/profile', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter); // access guard
    const body = upsertProfileSchema.parse(req.body);
    const profile = customersProfileService.upsert(tenantId(req), req.params['customerId']!, body as any);
    res.json({ data: profile });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/profile
customersRouter.get('/:customerId/profile', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    customersService.getById(tenantId(req), req.params['customerId']!, filter); // access guard
    const profile = customersProfileService.get(tenantId(req), req.params['customerId']!);
    if (!profile) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Profile not set yet. Use PUT to create it.' } });
      return;
    }
    res.json({ data: profile });
  } catch (err) { next(err); }
});

// ============================================================
// Identifiers
// ============================================================

const IDENTIFIER_TYPE = z.enum([
  'passport', 'national_id', 'driving_license', 'social_security',
  'tax_id', 'vat_id', 'company_reg', 'national_business_id',
  'lei', 'eori', 'duns', 'bic', 'internal', 'other',
]);

const createIdentifierSchema = z.object({
  type:              IDENTIFIER_TYPE,
  subtype:           z.string().max(100).nullish(),
  value:             z.string().min(1).max(500),
  issuing_country:   z.string().length(2).toUpperCase().nullish(),
  issuing_authority: z.string().max(500).nullish(),
  valid_from:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  valid_until:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  is_primary:        z.boolean().optional(),
  verified:          z.boolean().optional(),
  verified_at:       z.string().datetime().nullish(),
  verified_by:       z.string().max(200).nullish(),
});

const updateIdentifierSchema = createIdentifierSchema.omit({ type: true }).partial();

// POST /v1/customers/:customerId/identifiers
customersRouter.post('/:customerId/identifiers', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const body = createIdentifierSchema.parse(req.body);
    const identifier = customersIdentifiersService.create(tenantId(req), req.params['customerId']!, body);
    res.status(201).json({ data: identifier });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/identifiers
customersRouter.get('/:customerId/identifiers', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const identifiers = customersIdentifiersService.list(tenantId(req), req.params['customerId']!);
    res.json({ data: identifiers });
  } catch (err) { next(err); }
});

// PATCH /v1/customers/:customerId/identifiers/:identifierId
customersRouter.patch('/:customerId/identifiers/:identifierId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const body = updateIdentifierSchema.parse(req.body);
    const identifier = customersIdentifiersService.update(
      tenantId(req), req.params['customerId']!, req.params['identifierId']!, body
    );
    res.json({ data: identifier });
  } catch (err) { next(err); }
});

// DELETE /v1/customers/:customerId/identifiers/:identifierId
customersRouter.delete('/:customerId/identifiers/:identifierId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    customersIdentifiersService.delete(tenantId(req), req.params['customerId']!, req.params['identifierId']!);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ============================================================
// Relationships
// ============================================================

const RELATIONSHIP_TYPE = z.enum([
  'beneficial_owner', 'control_person', 'legal_representative', 'authorized_signatory',
  'board_member', 'foundation_board', 'trustee', 'settlor', 'beneficiary',
  'protector', 'nominee', 'shareholder', 'other',
]);

const externalPartySchema = z.object({
  display_name:      z.string().min(1).max(500),
  party_type:        PARTY_TYPE,
  country_of_origin: z.string().length(2).toUpperCase(),
  date_of_birth:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  identifier_type:   z.string().max(50).nullish(),
  identifier_value:  z.string().max(500).nullish(),
});

const createRelationshipSchema = z.object({
  related_customer_id:      z.string().optional(),
  external_party:           externalPartySchema.optional(),
  relationship_type:        RELATIONSHIP_TYPE,
  role_title:               z.string().max(200).nullish(),
  ownership_percentage:     z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).nullish(),
  voting_rights_percentage: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).nullish(),
  is_direct_ownership:      z.boolean().nullish(),
  valid_from:               z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  valid_until:              z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  verified:                 z.boolean().optional(),
  verified_at:              z.string().datetime().nullish(),
  verification_method:      z.enum(['document', 'declaration', 'registry', 'provider']).nullish(),
  notes:                    z.string().max(2000).nullish(),
});

const updateRelationshipSchema = createRelationshipSchema
  .omit({ related_customer_id: true, relationship_type: true })
  .partial();

// POST /v1/customers/:customerId/relationships
customersRouter.post('/:customerId/relationships', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const body = createRelationshipSchema.parse(req.body);
    const relationship = customersRelationshipsService.create(tenantId(req), req.params['customerId']!, body as any);
    res.status(201).json({ data: relationship });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/relationships
customersRouter.get('/:customerId/relationships', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const relationships = customersRelationshipsService.list(tenantId(req), req.params['customerId']!);
    res.json({ data: relationships });
  } catch (err) { next(err); }
});

// PATCH /v1/customers/:customerId/relationships/:relationshipId
customersRouter.patch('/:customerId/relationships/:relationshipId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const body = updateRelationshipSchema.parse(req.body);
    const relationship = customersRelationshipsService.update(
      tenantId(req), req.params['customerId']!, req.params['relationshipId']!, body as any
    );
    res.json({ data: relationship });
  } catch (err) { next(err); }
});

// DELETE /v1/customers/:customerId/relationships/:relationshipId
customersRouter.delete('/:customerId/relationships/:relationshipId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    customersRelationshipsService.delete(tenantId(req), req.params['customerId']!, req.params['relationshipId']!);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ============================================================
// AML / KYC
// ============================================================

const SOURCE_OF_FUNDS = z.enum([
  'salary', 'business_income', 'investments', 'inheritance',
  'savings', 'loan', 'sale_of_assets', 'gift', 'other',
]);

const upsertAmlKycSchema = z.object({
  kyc_status:               z.enum(['not_started', 'in_progress', 'pending_documents', 'verified', 'rejected', 'expired', 'suspended']).optional(),
  kyc_verified_at:          z.string().datetime().nullish(),
  kyc_expiry_date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  kyc_provider:             z.string().max(200).nullish(),
  kyc_provider_ref:         z.string().max(500).nullish(),
  cdd_level:                z.enum(['simplified', 'standard', 'enhanced']).optional(),
  cdd_level_reason:         z.string().max(1000).nullish(),
  cdd_approved_by:          z.string().max(200).nullish(),
  cdd_approved_at:          z.string().datetime().nullish(),
  aml_risk_level:           z.enum(['low', 'medium', 'high', 'very_high', 'unassessed']).optional(),
  aml_risk_score:           z.number().int().min(0).max(1000).nullish(),
  aml_risk_assessed_at:     z.string().datetime().nullish(),
  aml_risk_reviewed_by:     z.string().max(200).nullish(),
  aml_risk_next_review:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  pep_status:               z.enum(['not_pep', 'pep', 'former_pep', 'pep_associate', 'pep_family_member']).optional(),
  pep_checked_at:           z.string().datetime().nullish(),
  pep_details:              z.string().max(1000).nullish(),
  sanctions_status:         z.enum(['clear', 'hit', 'potential_match', 'whitelisted']).optional(),
  sanctions_checked_at:     z.string().datetime().nullish(),
  sanctions_lists:          z.array(z.string().max(50)).nullish(),
  sanctions_hit_details:    z.string().max(2000).nullish(),
  adverse_media_status:     z.enum(['clear', 'flag', 'monitoring']).nullish(),
  adverse_media_checked_at: z.string().datetime().nullish(),
  adverse_media_notes:      z.string().max(2000).nullish(),
  source_of_funds:          z.array(SOURCE_OF_FUNDS).nullish(),
  source_of_funds_details:  z.string().max(2000).nullish(),
  source_of_wealth:         z.array(SOURCE_OF_FUNDS).nullish(),
  source_of_wealth_details: z.string().max(2000).nullish(),
  expected_monthly_volume:  z.string().max(200).nullish(),
  expected_tx_types:        z.array(z.string().max(100)).nullish(),
  last_review_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  next_review_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

// PUT /v1/customers/:customerId/aml-kyc
customersRouter.put('/:customerId/aml-kyc', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const body = upsertAmlKycSchema.parse(req.body);
    const amlKyc = customersAmlKycService.upsert(tenantId(req), req.params['customerId']!, body);
    res.json({ data: amlKyc });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/aml-kyc
customersRouter.get('/:customerId/aml-kyc', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const amlKyc = customersAmlKycService.get(tenantId(req), req.params['customerId']!);
    if (!amlKyc) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'AML/KYC profile not found' } });
      return;
    }
    res.json({ data: amlKyc });
  } catch (err) { next(err); }
});

// ============================================================
// Data Governance
// ============================================================

const upsertDataGovernanceSchema = z.object({
  data_classification:      z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
  sensitivity_labels:       z.array(z.string().max(100)).nullish(),
  retention_policy_ref:     z.string().max(200).optional(),
  retention_until:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  deletion_eligible_at:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  lawful_basis:             z.enum(['contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests', 'consent']).optional(),
  lawful_basis_notes:       z.string().max(1000).nullish(),
  consent_reference:        z.string().max(500).nullish(),
  erasure_requested_at:     z.string().datetime().nullish(),
  erasure_blocked_until:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  erasure_completed_at:     z.string().datetime().nullish(),
  portability_requested_at: z.string().datetime().nullish(),
  masking_required:         z.boolean().optional(),
  encryption_required:      z.boolean().optional(),
  encryption_key_ref:       z.string().max(500).nullish(),
  source_system:            z.string().max(200).nullish(),
  source_system_id:         z.string().max(500).nullish(),
  created_by:               z.string().max(200).nullish(),
  last_modified_by:         z.string().max(200).nullish(),
  is_critical_entity:       z.boolean().nullish(),
  criticality_reason:       z.string().max(1000).nullish(),
  ict_risk_class:           z.string().max(200).nullish(),
});

// PUT /v1/customers/:customerId/data-governance
customersRouter.put('/:customerId/data-governance', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const body = upsertDataGovernanceSchema.parse(req.body);
    const dg = customersDataGovernanceService.upsert(tenantId(req), req.params['customerId']!, body);
    res.json({ data: dg });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/data-governance
customersRouter.get('/:customerId/data-governance', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const dg = customersDataGovernanceService.get(tenantId(req), req.params['customerId']!);
    if (!dg) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Data governance profile not found' } });
      return;
    }
    res.json({ data: dg });
  } catch (err) { next(err); }
});

// ============================================================
// Contact
// ============================================================

const postalAddressSchema = z.object({
  type:        z.enum(['registered', 'correspondence', 'residential', 'operational']),
  line1:       z.string().min(1).max(500),
  line2:       z.string().max(500).nullish(),
  city:        z.string().min(1).max(200),
  postal_code: z.string().max(20).nullish(),
  region:      z.string().max(200).nullish(),
  country:     z.string().length(2).toUpperCase(),
  is_primary:  z.boolean(),
  valid_from:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

const upsertContactSchema = z.object({
  email:              z.string().email().max(320).nullish(),
  email_verified:     z.boolean().optional(),
  phone:              z.string().max(20).nullish(),
  phone_verified:     z.boolean().optional(),
  preferred_language: z.string().length(2).nullish(),
  addresses:          z.array(postalAddressSchema).nullish(),
});

// PUT /v1/customers/:customerId/contact
customersRouter.put('/:customerId/contact', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const body = upsertContactSchema.parse(req.body);
    const contact = customersContactService.upsert(tenantId(req), req.params['customerId']!, body as any);
    res.json({ data: contact });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/contact
customersRouter.get('/:customerId/contact', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const contact = customersContactService.get(tenantId(req), req.params['customerId']!);
    if (!contact) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact not set yet. Use PUT to create it.' } });
      return;
    }
    res.json({ data: contact });
  } catch (err) { next(err); }
});

// ============================================================
// Documents
// ============================================================

const DOCUMENT_TYPE = z.enum([
  'passport', 'national_id', 'driving_license', 'proof_of_address', 'bank_statement',
  'company_certificate', 'articles_of_association', 'trust_deed', 'foundation_charter',
  'ubo_declaration', 'power_of_attorney', 'tax_certificate', 'financial_statements',
  'aml_questionnaire', 'regulatory_license', 'other',
]);

const createDocumentSchema = z.object({
  document_type:        DOCUMENT_TYPE,
  document_subtype:     z.string().max(200).nullish(),
  storage_ref:          z.string().min(1).max(2000),
  storage_system:       z.string().min(1).max(200),
  issuing_country:      z.string().length(2).toUpperCase().nullish(),
  issuing_authority:    z.string().max(500).nullish(),
  issued_date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  expiry_date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  document_number:      z.string().max(200).nullish(),
  linked_identifier_id: z.string().nullish(),
  verification_status:  z.enum(['pending', 'verified', 'rejected', 'expired']).optional(),
  verified_at:          z.string().datetime().nullish(),
  verified_by:          z.string().max(200).nullish(),
  file_hash:            z.string().max(64).nullish(),
  uploaded_by:          z.string().max(200).nullish(),
});

const updateDocumentSchema = z.object({
  document_subtype:     z.string().max(200).nullish(),
  storage_ref:          z.string().min(1).max(2000).optional(),
  storage_system:       z.string().min(1).max(200).optional(),
  issuing_country:      z.string().length(2).toUpperCase().nullish(),
  issuing_authority:    z.string().max(500).nullish(),
  issued_date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  expiry_date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  document_number:      z.string().max(200).nullish(),
  linked_identifier_id: z.string().nullish(),
  verification_status:  z.enum(['pending', 'verified', 'rejected', 'expired']).optional(),
  verified_at:          z.string().datetime().nullish(),
  verified_by:          z.string().max(200).nullish(),
  rejection_reason:     z.string().max(2000).nullish(),
  file_hash:            z.string().max(64).nullish(),
});

// POST /v1/customers/:customerId/documents
customersRouter.post('/:customerId/documents', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const body = createDocumentSchema.parse(req.body);
    const doc = customersDocumentsService.create(tenantId(req), req.params['customerId']!, body as any);
    res.status(201).json({ data: doc });
  } catch (err) { next(err); }
});

// GET /v1/customers/:customerId/documents
customersRouter.get('/:customerId/documents', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'read');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const docs = customersDocumentsService.list(tenantId(req), req.params['customerId']!);
    res.json({ data: docs });
  } catch (err) { next(err); }
});

// PATCH /v1/customers/:customerId/documents/:documentId
customersRouter.patch('/:customerId/documents/:documentId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    const body = updateDocumentSchema.parse(req.body);
    const doc = customersDocumentsService.update(
      tenantId(req), req.params['customerId']!, req.params['documentId']!, body as any
    );
    res.json({ data: doc });
  } catch (err) { next(err); }
});

// DELETE /v1/customers/:customerId/documents/:documentId
customersRouter.delete('/:customerId/documents/:documentId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filter = getAccessFilter(req, 'write');
    customersService.getById(tenantId(req), req.params['customerId']!, filter);
    customersDocumentsService.delete(tenantId(req), req.params['customerId']!, req.params['documentId']!);
    res.status(204).send();
  } catch (err) { next(err); }
});
