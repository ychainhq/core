import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { requireTenant, McpAuthContext } from '../context';
import { safeTool } from '../errors';
import { tenantsService } from '../../modules/tenants/tenants.service';
import { customersService } from '../../modules/customers/customers.service';
import { depositAddressService } from '../../modules/customers/deposit-address.service';
import { customersProfileService } from '../../modules/customers/customers-profile.service';
import { customersIdentifiersService } from '../../modules/customers/customers-identifiers.service';
import { customersRelationshipsService } from '../../modules/customers/customers-relationships.service';
import { customersAmlKycService } from '../../modules/customers/customers-aml-kyc.service';
import { customersDataGovernanceService } from '../../modules/customers/customers-data-governance.service';
import { customersContactService } from '../../modules/customers/customers-contact.service';
import { customersDocumentsService } from '../../modules/customers/customers-documents.service';
import { chainsService } from '../../modules/chains/chains.service';
import { assetsService } from '../../modules/assets/assets.service';
import { walletsService } from '../../modules/wallets/wallets.service';
import { addressesService } from '../../modules/addresses/addresses.service';
import { paymentRequestsService } from '../../modules/payment-requests/payment-requests.service';
import { depositsService } from '../../modules/deposits/deposits.service';
import { withdrawalsService } from '../../modules/withdrawals/withdrawals.service';
import { sweepsService } from '../../modules/sweeps/sweeps.service';
import { webhooksService } from '../../modules/webhooks/webhooks.service';
import { adapterRegistry } from '../../chain-adapters/registry';
import { detectAddressType } from '../../shared/validation/bitcoin';
import { config } from '../../config/index';
import { issueCustomerToken } from '../../shared/customer-auth/jwt.service';
import { bitcoinTransactionsService } from '../../modules/bitcoin/bitcoin-transactions.service';
import { idempotencyService } from '../../modules/idempotency/idempotency.service';

const paging = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
};

const customerDepositFilters = {
  status: z.string().optional(),
  depositId: z.string().min(1).optional(),
  txHash: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  assetId: z.string().min(1).optional(),
  minConfirmations: z.number().int().min(0).optional(),
  maxConfirmations: z.number().int().min(0).optional(),
};

const metadata = z.record(z.string(), z.unknown()).optional();

function page<T>(result: { data: T[]; nextCursor: string | null }, input: { limit?: number; cursor?: string }) {
  return {
    data: result.data,
    pagination: { limit: input.limit ?? 20, cursor: input.cursor ?? null, nextCursor: result.nextCursor },
  };
}

export function registerTenantTools(server: McpServer, ctx: McpAuthContext): void {
  const tenant = requireTenant(ctx);
  const tenantId = tenant.tenantId;

  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, openWorldHint: false };
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  server.registerTool('chainapi_get_tenant', {
    description: 'Get the authenticated tenant profile.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: tenantsService.getById(tenantId) })));

  server.registerTool('chainapi_update_tenant', {
    description: 'Update the authenticated tenant profile. Does not allow status changes.',
    inputSchema: {
      name: z.string().min(1).max(200).optional(),
      metadata,
    },
    annotations: write,
  }, async (input: any) => safeTool(() => ({ data: tenantsService.update(tenantId, input) })));

  server.registerTool('chainapi_get_tenant_config', {
    description: 'Get the authenticated tenant configuration.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: tenantsService.getById(tenantId).config })));

  server.registerTool('chainapi_update_tenant_config', {
    description: 'Update safe tenant configuration fields.',
    inputSchema: {
      btcConfirmationsRequired: z.number().int().min(0).optional(),
      btcFinalityConfirmations: z.number().int().min(1).optional(),
      withdrawalMode: z.enum(['external_signer', 'automatic', 'manual_approval', 'threshold_based']).optional(),
      dailyWithdrawalLimitSats: z.string().nullable().optional(),
      perTxLimitSats: z.string().nullable().optional(),
      btcXpub: z.string().min(1).nullable().optional(),
      btcSweepThresholdSats: z.string().regex(/^\d+$/).optional(),
      customerSessionTtlSeconds: z.number().int().min(60).max(86400).optional(),
    },
    annotations: write,
  }, async (input: any) => safeTool(async () => ({ data: await tenantsService.updateConfig(tenantId, input) })));

  server.registerTool('chainapi_list_chains', {
    description: 'List blockchain networks.',
    inputSchema: { enabled: z.boolean().optional(), type: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => ({ data: chainsService.list(input) })));

  server.registerTool('chainapi_get_chain', {
    description: 'Get blockchain network details.',
    inputSchema: { chain: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain }: any) => safeTool(() => ({ data: chainsService.getById(chain) })));

  server.registerTool('chainapi_list_assets', {
    description: 'List assets, optionally filtered by chain or type.',
    inputSchema: { chain: z.string().optional(), type: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => ({ data: assetsService.list(input) })));

  server.registerTool('chainapi_get_asset', {
    description: 'Get asset details for a chain and symbol.',
    inputSchema: { chain: z.string().min(1), asset: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, asset }: any) => safeTool(() => ({ data: assetsService.getByChainAndSymbol(chain, asset) })));

  server.registerTool('chainapi_create_customer', {
    description: 'Create a tenant-scoped customer (Party). party_type defaults to natural_person.',
    inputSchema: {
      reference: z.string().min(1).max(200).optional(),
      party_type: z.enum(['natural_person', 'legal_entity']).optional(),
      display_name: z.string().max(500).nullable().optional(),
      country_of_origin: z.string().length(2).nullable().optional(),
      metadata,
    },
    annotations: write,
  }, async (input: any) => safeTool(() => ({ data: customersService.create(tenantId, input) })));

  server.registerTool('chainapi_list_customers', {
    description: 'List tenant customers with optional filters. All text search fields support * as wildcard (e.g. "jan*" = starts with, "*ski" = ends with, "jan" = substring).',
    inputSchema: {
      ...paging,
      // customers table
      status:            z.string().optional(),
      party_type:        z.enum(['natural_person', 'legal_entity']).optional(),
      id:                z.string().optional(),
      reference:         z.string().optional(),
      display_name:      z.string().optional(),
      country_of_origin: z.string().min(2).max(2).optional(),
      // customer_profiles
      profile_given_name:    z.string().optional(),
      profile_family_name:   z.string().optional(),
      profile_middle_name:   z.string().optional(),
      profile_business_name: z.string().optional(),
      // customer_contact
      contact_email: z.string().optional(),
      contact_phone: z.string().optional(),
      // customer_identifiers
      identifier_type:  z.string().optional(),
      identifier_value: z.string().optional(),
      // customer_relationships external_party
      rel_display_name:     z.string().optional(),
      rel_identifier_type:  z.string().optional(),
      rel_identifier_value: z.string().optional(),
    },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(customersService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_customer', {
    description: 'Get customer details.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersService.getById(tenantId, customerId) })));

  server.registerTool('chainapi_update_customer', {
    description: 'Update a tenant customer.',
    inputSchema: {
      customerId: z.string().min(1),
      reference: z.string().min(1).max(200).optional(),
      status: z.enum(['active', 'pending', 'restricted', 'suspended', 'frozen', 'closed', 'rejected', 'disabled']).optional(),
      display_name: z.string().max(500).nullable().optional(),
      country_of_origin: z.string().length(2).nullable().optional(),
      metadata,
    },
    annotations: write,
  }, async ({ customerId, ...input }: any) => safeTool(() => ({ data: customersService.update(tenantId, customerId, input) })));

  server.registerTool('chainapi_disable_customer', {
    description: 'Disable a tenant customer.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: destructive,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersService.disable(tenantId, customerId) })));

  server.registerTool('chainapi_get_customer_balances', {
    description: 'Get customer ledger balances.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersService.getBalances(tenantId, customerId) })));

  server.registerTool('chainapi_list_customer_deposits', {
    description: 'List deposits for a customer.',
    inputSchema: { customerId: z.string().min(1), ...paging, ...customerDepositFilters },
    annotations: readOnly,
  }, async ({ customerId, ...input }: any) => safeTool(() => page(customersService.getDeposits(tenantId, customerId, input), input)));

  server.registerTool('chainapi_list_customer_addresses', {
    description: 'List deposit addresses for a customer.',
    inputSchema: { customerId: z.string().min(1), ...paging },
    annotations: readOnly,
  }, async ({ customerId, ...input }: any) => safeTool(() => page(customersService.getAddresses(tenantId, customerId, input), input)));

  server.registerTool('chainapi_create_customer_session', {
    description: 'Issue a short-lived customer session token.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: write,
  }, async ({ customerId }: any) => safeTool(() => {
    const customer = customersService.getById(tenantId, customerId);
    if (customer.status !== 'active') throw new Error(`Customer account is ${customer.status}`);
    const ttl = tenantsService.getById(tenantId).config?.customer_session_ttl_seconds ?? undefined;
    const { accessToken, expiresAt } = issueCustomerToken(tenantId, customer.id, ttl);
    return { data: { accessToken, expiresAt, customerId: customer.id } };
  }));

  server.registerTool('chainapi_create_customer_deposit_address', {
    description: 'Generate a new BTC deposit address for a customer.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: write,
  }, async ({ customerId }: any) => safeTool(async () => {
    customersService.getById(tenantId, customerId);
    return { data: await depositAddressService.generateForCustomer(tenantId, customerId) };
  }));

  // ── Customer KYC sub-resources ──────────────────────────────────────────────

  server.registerTool('chainapi_get_customer_profile', {
    description: 'Get the KYC profile for a customer (natural person or legal entity).',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersProfileService.get(tenantId, customerId) })));

  server.registerTool('chainapi_upsert_customer_profile', {
    description: 'Create or replace the KYC profile for a customer. partyType must match the customer party_type.',
    inputSchema: {
      customerId: z.string().min(1),
      partyType: z.enum(['natural_person', 'legal_entity']),
      given_name: z.string().min(1).optional(),
      family_name: z.string().min(1).optional(),
      middle_name: z.string().nullable().optional(),
      date_of_birth: z.string().nullable().optional(),
      place_of_birth: z.string().nullable().optional(),
      nationalities: z.array(z.string()).nullable().optional(),
      country_of_residence: z.string().nullable().optional(),
      occupation: z.string().nullable().optional(),
      employer_name: z.string().nullable().optional(),
      employer_country: z.string().nullable().optional(),
      business_name: z.string().nullable().optional(),
      business_activity: z.string().nullable().optional(),
      gender: z.enum(['male', 'female', 'other', 'not_stated']).nullable().optional(),
      person_type: z.enum(['natural', 'sole_proprietor']).optional(),
      entity_subtype: z.enum(['company', 'foundation', 'ngo', 'trust', 'partnership', 'public_entity', 'other']).optional(),
      entity_subtype_other: z.string().nullable().optional(),
      legal_name: z.string().min(1).optional(),
      trade_name: z.string().nullable().optional(),
      country_of_incorporation: z.string().optional(),
      date_of_incorporation: z.string().nullable().optional(),
      legal_form: z.string().nullable().optional(),
      jurisdiction: z.string().nullable().optional(),
      industry_code: z.string().nullable().optional(),
      industry_code_type: z.enum(['nace', 'naics', 'sic', 'isic', 'other']).nullable().optional(),
      purpose_statement: z.string().nullable().optional(),
      regulated: z.boolean().nullable().optional(),
      regulatory_status: z.string().nullable().optional(),
      regulatory_body: z.string().nullable().optional(),
      regulatory_ref: z.string().nullable().optional(),
      is_listed_company: z.boolean().nullable().optional(),
      stock_exchange: z.string().nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, ...input }: any) => safeTool(() => ({ data: customersProfileService.upsert(tenantId, customerId, input) })));

  server.registerTool('chainapi_list_customer_identifiers', {
    description: 'List KYC identifiers for a customer (passport, tax ID, LEI, etc.).',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersIdentifiersService.list(tenantId, customerId) })));

  server.registerTool('chainapi_add_customer_identifier', {
    description: 'Add a KYC identifier to a customer.',
    inputSchema: {
      customerId: z.string().min(1),
      type: z.enum(['passport', 'national_id', 'driving_license', 'social_security', 'tax_id', 'vat_id', 'company_reg', 'national_business_id', 'lei', 'eori', 'duns', 'bic', 'internal', 'other']),
      value: z.string().min(1),
      issuing_country: z.string().length(2).nullable().optional(),
      issuing_authority: z.string().nullable().optional(),
      valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      verified: z.boolean().optional(),
      verified_at: z.string().nullable().optional(),
      verified_by: z.string().nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, ...input }: any) => safeTool(() => ({ data: customersIdentifiersService.create(tenantId, customerId, input) })));

  server.registerTool('chainapi_update_customer_identifier', {
    description: 'Update a KYC identifier record.',
    inputSchema: {
      customerId: z.string().min(1),
      identifierId: z.string().min(1),
      value: z.string().min(1).optional(),
      issuing_country: z.string().length(2).nullable().optional(),
      issuing_authority: z.string().nullable().optional(),
      valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      verified: z.boolean().optional(),
      verified_at: z.string().nullable().optional(),
      verified_by: z.string().nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, identifierId, ...input }: any) => safeTool(() => ({ data: customersIdentifiersService.update(tenantId, customerId, identifierId, input) })));

  server.registerTool('chainapi_delete_customer_identifier', {
    description: 'Delete a KYC identifier from a customer.',
    inputSchema: { customerId: z.string().min(1), identifierId: z.string().min(1) },
    annotations: destructive,
  }, async ({ customerId, identifierId }: any) => safeTool(() => { customersIdentifiersService.delete(tenantId, customerId, identifierId); return { data: null }; }));

  server.registerTool('chainapi_list_customer_relationships', {
    description: 'List party relationships for a customer (UBOs, directors, representatives, etc.).',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersRelationshipsService.list(tenantId, customerId) })));

  server.registerTool('chainapi_add_customer_relationship', {
    description: 'Add a party relationship to a customer. Provide related_customer_id (internal) or external_party snapshot.',
    inputSchema: {
      customerId: z.string().min(1),
      relationship_type: z.enum(['beneficial_owner', 'control_person', 'legal_representative', 'authorized_signatory', 'board_member', 'foundation_board', 'trustee', 'settlor', 'beneficiary', 'protector', 'nominee', 'shareholder', 'other']),
      related_customer_id: z.string().nullable().optional(),
      external_party: z.object({
        legal_name: z.string().min(1),
        identifier_type: z.string().optional(),
        identifier_value: z.string().optional(),
        country: z.string().optional(),
      }).nullable().optional(),
      ownership_percent: z.number().min(0).max(100).nullable().optional(),
      is_controlling: z.boolean().optional(),
      from_date: z.string().nullable().optional(),
      to_date: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, ...input }: any) => safeTool(() => ({ data: customersRelationshipsService.create(tenantId, customerId, input) })));

  server.registerTool('chainapi_update_customer_relationship', {
    description: 'Update a party relationship record.',
    inputSchema: {
      customerId: z.string().min(1),
      relationshipId: z.string().min(1),
      ownership_percent: z.number().min(0).max(100).nullable().optional(),
      is_controlling: z.boolean().optional(),
      from_date: z.string().nullable().optional(),
      to_date: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, relationshipId, ...input }: any) => safeTool(() => ({ data: customersRelationshipsService.update(tenantId, customerId, relationshipId, input) })));

  server.registerTool('chainapi_delete_customer_relationship', {
    description: 'Delete a party relationship from a customer.',
    inputSchema: { customerId: z.string().min(1), relationshipId: z.string().min(1) },
    annotations: destructive,
  }, async ({ customerId, relationshipId }: any) => safeTool(() => { customersRelationshipsService.delete(tenantId, customerId, relationshipId); return { data: null }; }));

  server.registerTool('chainapi_get_customer_aml_kyc', {
    description: 'Get the AML/KYC record for a customer.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersAmlKycService.get(tenantId, customerId) })));

  server.registerTool('chainapi_upsert_customer_aml_kyc', {
    description: 'Create or update the AML/KYC record for a customer.',
    inputSchema: {
      customerId: z.string().min(1),
      kyc_status: z.enum(['not_started', 'in_progress', 'pending_documents', 'verified', 'rejected', 'expired', 'suspended']).optional(),
      kyc_verified_at: z.string().nullable().optional(),
      kyc_expiry_date: z.string().nullable().optional(),
      kyc_provider: z.string().nullable().optional(),
      kyc_provider_ref: z.string().nullable().optional(),
      cdd_level: z.enum(['simplified', 'standard', 'enhanced']).optional(),
      cdd_level_reason: z.string().nullable().optional(),
      cdd_approved_by: z.string().nullable().optional(),
      cdd_approved_at: z.string().nullable().optional(),
      aml_risk_level: z.enum(['low', 'medium', 'high', 'very_high', 'unassessed']).optional(),
      aml_risk_score: z.number().nullable().optional(),
      aml_risk_assessed_at: z.string().nullable().optional(),
      aml_risk_reviewed_by: z.string().nullable().optional(),
      aml_risk_next_review: z.string().nullable().optional(),
      pep_status: z.enum(['not_pep', 'pep', 'former_pep', 'pep_associate', 'pep_family_member']).optional(),
      pep_checked_at: z.string().nullable().optional(),
      pep_details: z.string().nullable().optional(),
      sanctions_status: z.enum(['clear', 'hit', 'potential_match', 'whitelisted']).optional(),
      sanctions_checked_at: z.string().nullable().optional(),
      sanctions_lists: z.array(z.string()).nullable().optional(),
      sanctions_hit_details: z.string().nullable().optional(),
      adverse_media_status: z.enum(['clear', 'flag', 'monitoring']).nullable().optional(),
      adverse_media_checked_at: z.string().nullable().optional(),
      adverse_media_notes: z.string().nullable().optional(),
      source_of_funds: z.array(z.enum(['salary', 'business_income', 'investments', 'inheritance', 'savings', 'loan', 'sale_of_assets', 'gift', 'other'])).nullable().optional(),
      source_of_funds_details: z.string().nullable().optional(),
      source_of_wealth: z.array(z.enum(['salary', 'business_income', 'investments', 'inheritance', 'savings', 'loan', 'sale_of_assets', 'gift', 'other'])).nullable().optional(),
      source_of_wealth_details: z.string().nullable().optional(),
      expected_monthly_volume: z.string().nullable().optional(),
      expected_tx_types: z.array(z.string()).nullable().optional(),
      last_review_date: z.string().nullable().optional(),
      next_review_date: z.string().nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, ...input }: any) => safeTool(() => ({ data: customersAmlKycService.upsert(tenantId, customerId, input) })));

  server.registerTool('chainapi_get_customer_data_governance', {
    description: 'Get the GDPR/DORA data governance record for a customer.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersDataGovernanceService.get(tenantId, customerId) })));

  server.registerTool('chainapi_upsert_customer_data_governance', {
    description: 'Create or update the GDPR/DORA data governance record for a customer. Increments version on every write.',
    inputSchema: {
      customerId: z.string().min(1),
      data_classification: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
      lawful_basis: z.enum(['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests']).optional(),
      consent_ref: z.string().nullable().optional(),
      retention_policy: z.string().nullable().optional(),
      retention_until: z.string().nullable().optional(),
      erasure_requested_at: z.string().nullable().optional(),
      erasure_completed_at: z.string().nullable().optional(),
      masking_required: z.boolean().optional(),
      encryption_required: z.boolean().optional(),
      is_critical_entity: z.boolean().optional(),
      dora_classification: z.string().nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, ...input }: any) => safeTool(() => ({ data: customersDataGovernanceService.upsert(tenantId, customerId, input) })));

  server.registerTool('chainapi_get_customer_contact', {
    description: 'Get contact details for a customer.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersContactService.get(tenantId, customerId) })));

  server.registerTool('chainapi_upsert_customer_contact', {
    description: 'Create or update contact details for a customer.',
    inputSchema: {
      customerId: z.string().min(1),
      email: z.string().email().nullable().optional(),
      phone: z.string().nullable().optional(),
      phone_verified: z.boolean().optional(),
      email_verified: z.boolean().optional(),
      addresses: z.array(z.object({
        address_type: z.enum(['residential', 'registered', 'correspondence', 'business', 'other']),
        line1: z.string().min(1),
        line2: z.string().nullable().optional(),
        city: z.string().min(1),
        state: z.string().nullable().optional(),
        postal_code: z.string().nullable().optional(),
        country: z.string().length(2),
        is_primary: z.boolean().optional(),
      })).nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, ...input }: any) => safeTool(() => ({ data: customersContactService.upsert(tenantId, customerId, input) })));

  server.registerTool('chainapi_list_customer_documents', {
    description: 'List KYC documents for a customer.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersDocumentsService.list(tenantId, customerId) })));

  server.registerTool('chainapi_add_customer_document', {
    description: 'Add a KYC document reference for a customer.',
    inputSchema: {
      customerId: z.string().min(1),
      document_type: z.enum(['passport', 'national_id', 'driving_license', 'residence_permit', 'utility_bill', 'bank_statement', 'company_reg_cert', 'articles_of_association', 'trust_deed', 'power_of_attorney', 'tax_cert', 'financial_statement', 'source_of_funds_letter', 'source_of_wealth_letter', 'selfie', 'other']),
      document_subtype: z.string().nullable().optional(),
      storage_ref: z.string().min(1),
      storage_system: z.string().min(1),
      issuing_country: z.string().length(2).nullable().optional(),
      issuing_authority: z.string().nullable().optional(),
      issued_date: z.string().nullable().optional(),
      expiry_date: z.string().nullable().optional(),
      document_number: z.string().nullable().optional(),
      linked_identifier_id: z.string().nullable().optional(),
      verification_status: z.enum(['pending', 'verified', 'rejected', 'expired']).optional(),
      file_hash: z.string().nullable().optional(),
      uploaded_by: z.string().nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, ...input }: any) => safeTool(() => ({ data: customersDocumentsService.create(tenantId, customerId, input) })));

  server.registerTool('chainapi_update_customer_document', {
    description: 'Update a KYC document record (e.g. set verification_status after review).',
    inputSchema: {
      customerId: z.string().min(1),
      documentId: z.string().min(1),
      verification_status: z.enum(['pending', 'verified', 'rejected', 'expired']).optional(),
      verified_at: z.string().nullable().optional(),
      verified_by: z.string().nullable().optional(),
      rejection_reason: z.string().nullable().optional(),
      expiry_date: z.string().nullable().optional(),
      document_number: z.string().nullable().optional(),
      linked_identifier_id: z.string().nullable().optional(),
      file_hash: z.string().nullable().optional(),
    },
    annotations: write,
  }, async ({ customerId, documentId, ...input }: any) => safeTool(() => ({ data: customersDocumentsService.update(tenantId, customerId, documentId, input) })));

  server.registerTool('chainapi_delete_customer_document', {
    description: 'Delete a KYC document from a customer.',
    inputSchema: { customerId: z.string().min(1), documentId: z.string().min(1) },
    annotations: destructive,
  }, async ({ customerId, documentId }: any) => safeTool(() => { customersDocumentsService.delete(tenantId, customerId, documentId); return { data: null }; }));

  server.registerTool('chainapi_create_wallet', {
    description: 'Create a logical wallet.',
    inputSchema: {
      name: z.string().min(1).max(200),
      type: z.enum(['watch_only', 'external_signer']),
      walletRole: z.enum(['watch_only', 'tenant_hot', 'tenant_cold', 'customer_deposits', 'external_signer']).optional(),
      metadata,
    },
    annotations: write,
  }, async (input: any) => safeTool(() => ({ data: walletsService.create(tenantId, input) })));

  server.registerTool('chainapi_list_wallets', {
    description: 'List logical wallets.',
    inputSchema: { ...paging, type: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(walletsService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_wallet', {
    description: 'Get logical wallet details.',
    inputSchema: { walletId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ walletId }: any) => safeTool(() => ({ data: walletsService.getById(tenantId, walletId) })));

  server.registerTool('chainapi_register_wallet_address', {
    description: 'Register an address to a logical wallet and watch it.',
    inputSchema: {
      walletId: z.string().min(1),
      chain: z.string().min(1),
      address: z.string().min(1),
      label: z.string().max(200).optional(),
      addressType: z.string().optional(),
      addressRole: z.string().optional(),
      customerId: z.string().optional(),
      metadata,
    },
    annotations: write,
  }, async ({ walletId, ...input }: any) => safeTool(() => ({ data: addressesService.addToWallet(tenantId, walletId, input) })));

  server.registerTool('chainapi_list_wallet_addresses', {
    description: 'List addresses registered to a wallet.',
    inputSchema: { walletId: z.string().min(1), ...paging },
    annotations: readOnly,
  }, async ({ walletId, ...input }: any) => safeTool(() => page(addressesService.listByWallet(tenantId, walletId, input), input)));

  server.registerTool('chainapi_validate_address', {
    description: 'Validate an address for a chain. This is read-only even though REST uses POST.',
    inputSchema: { chain: z.string().min(1), address: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, address }: any) => safeTool(() => {
    const adapter = adapterRegistry.get(chain);
    const valid = adapter.isValidAddress(address);
    const format = chain === 'bitcoin' ? detectAddressType(address, config.BITCOIN_NETWORK) ?? undefined : undefined;
    return { data: { valid, address, chain, format } };
  }));

  server.registerTool('chainapi_get_wallet_balances', {
    description: 'Get on-chain balances for a wallet.',
    inputSchema: { walletId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ walletId }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getWalletBalances(tenantId, walletId) })));

  server.registerTool('chainapi_get_address_balances', {
    description: 'Get on-chain balances for an address.',
    inputSchema: { chain: z.string().min(1), address: z.string().min(1), asset: z.string().optional() },
    annotations: readOnly,
  }, async ({ chain, address, asset }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getAddressBalance(tenantId, chain, address, asset) })));

  server.registerTool('chainapi_list_address_utxos', {
    description: 'List BTC UTXOs for an address.',
    inputSchema: { address: z.string().min(1), minConfirmations: z.number().int().min(0).optional() },
    annotations: readOnly,
  }, async ({ address, minConfirmations }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getAddressUtxos(tenantId, address, minConfirmations ?? 0) })));

  server.registerTool('chainapi_list_wallet_utxos', {
    description: 'List BTC UTXOs for all active wallet addresses.',
    inputSchema: { walletId: z.string().min(1), minConfirmations: z.number().int().min(0).optional() },
    annotations: readOnly,
  }, async ({ walletId, minConfirmations }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getWalletUtxos(tenantId, walletId, minConfirmations ?? 0) })));

  server.registerTool('chainapi_get_bitcoin_fees', {
    description: 'Get BTC fee estimates.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(async () => ({ data: await bitcoinTransactionsService.getFees() })));

  server.registerTool('chainapi_create_payment_request', {
    description: 'Create a payment request. Supports idempotencyKey.',
    inputSchema: {
      chain: z.string().min(1),
      asset: z.string().min(1),
      amount: z.string().min(1),
      walletId: z.string().optional(),
      address: z.string().optional(),
      customerId: z.string().optional(),
      reference: z.string().max(200).optional(),
      expiresAt: z.string().optional(),
      confirmationsRequired: z.number().int().min(0).max(100).optional(),
      metadata,
      idempotencyKey: z.string().optional(),
    },
    annotations: { ...write, idempotentHint: true },
  }, async ({ idempotencyKey, ...input }: any) => safeTool(() => {
    if (idempotencyKey) {
      const existing = idempotencyService.get(tenantId, idempotencyKey, 'payment_request');
      if (existing) return existing.result;
    }
    const paymentRequest = paymentRequestsService.create(tenantId, input);
    const result = { data: paymentRequest };
    if (idempotencyKey) idempotencyService.save(tenantId, idempotencyKey, 'payment_request', result, 201);
    return result;
  }));

  server.registerTool('chainapi_list_payment_requests', {
    description: 'List payment requests.',
    inputSchema: { ...paging, status: z.string().optional(), chain: z.string().optional(), reference: z.string().optional(), walletId: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(paymentRequestsService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_payment_request', {
    description: 'Get payment request details.',
    inputSchema: { paymentRequestId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ paymentRequestId }: any) => safeTool(() => ({ data: paymentRequestsService.getById(tenantId, paymentRequestId) })));

  server.registerTool('chainapi_get_payment_requests_by_reference', {
    description: 'Get payment requests by tenant reference.',
    inputSchema: { reference: z.string().min(1) },
    annotations: readOnly,
  }, async ({ reference }: any) => safeTool(() => ({ data: paymentRequestsService.getByReference(tenantId, reference) })));

  server.registerTool('chainapi_get_payment_request_qr', {
    description: 'Get BIP-21 QR payload for a payment request.',
    inputSchema: { paymentRequestId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ paymentRequestId }: any) => safeTool(() => {
    const pr = paymentRequestsService.getById(tenantId, paymentRequestId);
    return { data: { paymentRequestId: pr.id, format: 'payload', qrPayload: pr.qr_payload } };
  }));

  server.registerTool('chainapi_cancel_payment_request', {
    description: 'Cancel a payment request.',
    inputSchema: { paymentRequestId: z.string().min(1) },
    annotations: destructive,
  }, async ({ paymentRequestId }: any) => safeTool(() => ({ data: paymentRequestsService.cancel(tenantId, paymentRequestId) })));

  server.registerTool('chainapi_list_deposits', {
    description: 'List tenant deposits.',
    inputSchema: { ...paging, walletId: z.string().optional(), chain: z.string().optional(), status: z.string().optional(), address: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(depositsService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_deposit', {
    description: 'Get deposit details.',
    inputSchema: { depositId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ depositId }: any) => safeTool(() => ({ data: depositsService.getById(tenantId, depositId) })));

  server.registerTool('chainapi_list_address_deposits', {
    description: 'List deposits for a chain address.',
    inputSchema: { chain: z.string().min(1), address: z.string().min(1), ...paging, status: z.string().optional(), walletId: z.string().optional() },
    annotations: readOnly,
  }, async ({ chain, address, ...input }: any) => safeTool(() => page(depositsService.list(tenantId, { ...input, chain, address }), input)));

  server.registerTool('chainapi_list_withdrawals', {
    description: 'List tenant customer withdrawals.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(withdrawalsService.listForTenant(tenantId, input), input)));

  server.registerTool('chainapi_get_withdrawal', {
    description: 'Get withdrawal details.',
    inputSchema: { withdrawalId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ withdrawalId }: any) => safeTool(() => ({ data: withdrawalsService.getById(tenantId, withdrawalId) })));

  server.registerTool('chainapi_submit_signed_withdrawal', {
    description: 'Submit a signed PSBT for a pending withdrawal.',
    inputSchema: { withdrawalId: z.string().min(1), signedPsbt: z.string().min(1) },
    annotations: destructive,
  }, async ({ withdrawalId, signedPsbt }: any) => safeTool(async () => ({ data: await withdrawalsService.submitSigned(tenantId, withdrawalId, signedPsbt) })));

  server.registerTool('chainapi_list_sweeps', {
    description: 'List tenant sweeps.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(sweepsService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_sweep', {
    description: 'Get sweep details.',
    inputSchema: { sweepId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ sweepId }: any) => safeTool(() => ({ data: sweepsService.getById(tenantId, sweepId) })));

  server.registerTool('chainapi_submit_signed_sweep', {
    description: 'Submit a signed PSBT for a pending sweep.',
    inputSchema: { sweepId: z.string().min(1), signedPsbt: z.string().min(1) },
    annotations: destructive,
  }, async ({ sweepId, signedPsbt }: any) => safeTool(async () => ({ data: await sweepsService.submitSigned(tenantId, sweepId, signedPsbt) })));

  server.registerTool('chainapi_bitcoin_coin_selection', {
    description: 'Preview BTC coin selection. Read-only.',
    inputSchema: {
      fromAddresses: z.array(z.string().min(1)).min(1),
      outputs: z.array(z.object({ address: z.string().min(1), amount: z.string().regex(/^\d+$/) })).min(1),
      feeRate: z.number().positive(),
      changeAddress: z.string().min(1),
    },
    annotations: readOnly,
  }, async (input: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.coinSelection(tenantId, input) })));

  server.registerTool('chainapi_bitcoin_prepare_transaction', {
    description: 'Prepare an unsigned BTC transaction or PSBT.',
    inputSchema: {
      fromAddresses: z.array(z.string().min(1)).min(1),
      outputs: z.array(z.object({ address: z.string().min(1), amount: z.string().regex(/^\d+$/) })).min(1),
      changeAddress: z.string().min(1),
      feePolicy: z.object({ feeRate: z.number().positive().optional(), targetBlocks: z.number().int().min(1).optional() }).optional(),
      format: z.enum(['psbt', 'raw']).optional(),
      walletId: z.string().optional(),
    },
    annotations: write,
  }, async (input: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.prepare(tenantId, input) })));

  server.registerTool('chainapi_bitcoin_finalize_psbt', {
    description: 'Finalize a signed PSBT into a raw transaction.',
    inputSchema: { psbt: z.string().min(1) },
    annotations: write,
  }, async ({ psbt }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.finalizePsbt(psbt) })));

  server.registerTool('chainapi_validate_raw_transaction', {
    description: 'Validate raw transaction mempool acceptance without broadcasting.',
    inputSchema: { chain: z.string().min(1).default('bitcoin'), rawTransaction: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, rawTransaction }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.validateRaw(chain, rawTransaction) })));

  server.registerTool('chainapi_broadcast_raw_transaction', {
    description: 'Broadcast a raw transaction to the chain.',
    inputSchema: { chain: z.string().min(1).default('bitcoin'), rawTransaction: z.string().min(1), idempotencyKey: z.string().optional() },
    annotations: { ...destructive, idempotentHint: true },
  }, async ({ chain, rawTransaction, idempotencyKey }: any) => safeTool(async () => {
    if (idempotencyKey) {
      const existing = idempotencyService.get(tenantId, idempotencyKey, 'broadcast');
      if (existing) return existing.result;
    }
    const result = { data: await bitcoinTransactionsService.broadcast(tenantId, chain, rawTransaction) };
    if (idempotencyKey) idempotencyService.save(tenantId, idempotencyKey, 'broadcast', result, 200);
    return result;
  }));

  server.registerTool('chainapi_get_transaction', {
    description: 'Get transaction details from chain and local record.',
    inputSchema: { chain: z.string().min(1), txHash: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, txHash }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getTransaction(chain, txHash) })));

  server.registerTool('chainapi_get_transaction_status', {
    description: 'Get transaction status.',
    inputSchema: { chain: z.string().min(1), txHash: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, txHash }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getTransactionStatus(chain, txHash) })));

  server.registerTool('chainapi_list_webhooks', {
    description: 'List tenant webhooks. Does not return webhook secrets.',
    inputSchema: { ...paging, walletId: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(webhooksService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_webhook', {
    description: 'Get tenant webhook details. Does not return webhook secret.',
    inputSchema: { webhookId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ webhookId }: any) => safeTool(() => ({ data: webhooksService.getById(tenantId, webhookId) })));

  server.registerTool('chainapi_list_webhook_deliveries', {
    description: 'List webhook delivery attempts.',
    inputSchema: { ...paging, webhookId: z.string().optional(), eventType: z.string().optional(), status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(webhooksService.listDeliveries(tenantId, input), input)));

  server.registerTool('chainapi_test_webhook', {
    description: 'Send a test event to a webhook URL.',
    inputSchema: { webhookId: z.string().min(1) },
    annotations: write,
  }, async ({ webhookId }: any) => safeTool(async () => ({ data: await webhooksService.test(tenantId, webhookId) })));

  server.registerTool('chainapi_retry_webhook_delivery', {
    description: 'Mark a webhook delivery for retry by the delivery worker.',
    inputSchema: { deliveryId: z.string().min(1) },
    annotations: write,
  }, async ({ deliveryId }: any) => safeTool(() => ({ data: webhooksService.retryDelivery(tenantId, deliveryId) })));
}
