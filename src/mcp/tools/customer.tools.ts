import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { McpAuthContext, requireCustomer } from '../context';
import { safeTool } from '../errors';
import { customersService } from '../../modules/customers/customers.service';
import { depositAddressService } from '../../modules/customers/deposit-address.service';
import { withdrawalsService } from '../../modules/withdrawals/withdrawals.service';
import { customersProfileService } from '../../modules/customers/customers-profile.service';
import { customersContactService } from '../../modules/customers/customers-contact.service';
import { customersDocumentsService } from '../../modules/customers/customers-documents.service';
import { customersAmlKycService } from '../../modules/customers/customers-aml-kyc.service';
import { NotFoundError } from '../../shared/errors/index';

const paging = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
};

function page<T>(result: { data: T[]; nextCursor: string | null }, input: { limit?: number; cursor?: string }) {
  return {
    data: result.data,
    pagination: { limit: input.limit ?? 20, cursor: input.cursor ?? null, nextCursor: result.nextCursor },
  };
}

export function registerCustomerTools(server: McpServer, ctx: McpAuthContext): void {
  const customer = requireCustomer(ctx);
  const { tenantId, customerId } = customer;
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, openWorldHint: false };

  server.registerTool('chainapi_me_get_profile', {
    description: 'Get the authenticated customer profile.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: customersService.getById(tenantId, customerId) })));

  server.registerTool('chainapi_me_get_balances', {
    description: 'Get the authenticated customer ledger balances.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: customersService.getBalances(tenantId, customerId) })));

  server.registerTool('chainapi_me_list_deposits', {
    description: 'List deposits for the authenticated customer.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(customersService.getDeposits(tenantId, customerId, input), input)));

  server.registerTool('chainapi_me_list_addresses', {
    description: 'List deposit addresses for the authenticated customer.',
    inputSchema: { ...paging },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(customersService.getAddresses(tenantId, customerId, input), input)));

  server.registerTool('chainapi_me_create_deposit_address', {
    description: 'Generate a new BTC deposit address for the authenticated customer.',
    inputSchema: {},
    annotations: write,
  }, async () => safeTool(async () => ({ data: await depositAddressService.generateForCustomer(tenantId, customerId) })));

  server.registerTool('chainapi_me_create_withdrawal', {
    description: 'Create a customer withdrawal request and signing payload.',
    inputSchema: {
      toAddress: z.string().min(1),
      amountSats: z.string().regex(/^\d+$/),
      idempotencyKey: z.string().optional(),
    },
    annotations: { ...write, idempotentHint: true },
  }, async (input: any) => safeTool(async () => ({ data: await withdrawalsService.create(tenantId, customerId, input) })));

  server.registerTool('chainapi_me_list_withdrawals', {
    description: 'List withdrawals for the authenticated customer.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(withdrawalsService.list(tenantId, customerId, input), input)));

  server.registerTool('chainapi_me_get_withdrawal', {
    description: 'Get a withdrawal for the authenticated customer.',
    inputSchema: { withdrawalId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ withdrawalId }: any) => safeTool(() => {
    const withdrawal = withdrawalsService.getById(tenantId, withdrawalId);
    if (withdrawal.customer_id !== customerId) {
      throw new NotFoundError('Withdrawal', withdrawalId);
    }
    return { data: withdrawal };
  }));

  // ── Customer self-service KYC ───────────────────────────────────────────────

  server.registerTool('chainapi_me_get_kyc_profile', {
    description: 'Get the KYC profile of the authenticated customer (natural person or legal entity data).',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: customersProfileService.get(tenantId, customerId) })));

  server.registerTool('chainapi_me_upsert_kyc_profile', {
    description: 'Create or update the KYC profile of the authenticated customer. partyType must match the customer account type.',
    inputSchema: {
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
    },
    annotations: write,
  }, async (input: any) => safeTool(() => ({ data: customersProfileService.upsert(tenantId, customerId, input) })));

  server.registerTool('chainapi_me_get_contact', {
    description: 'Get the contact details of the authenticated customer.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: customersContactService.get(tenantId, customerId) })));

  server.registerTool('chainapi_me_upsert_contact', {
    description: 'Create or update the contact details of the authenticated customer.',
    inputSchema: {
      email: z.string().email().nullable().optional(),
      phone: z.string().nullable().optional(),
      email_verified: z.boolean().optional(),
      phone_verified: z.boolean().optional(),
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
  }, async (input: any) => safeTool(() => ({ data: customersContactService.upsert(tenantId, customerId, input) })));

  server.registerTool('chainapi_me_get_kyc_status', {
    description: 'Get the KYC status of the authenticated customer (read-only view of compliance decisions).',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => {
    const record = customersAmlKycService.get(tenantId, customerId);
    if (!record) return { data: { kyc_status: 'not_started', cdd_level: 'standard' } };
    return {
      data: {
        kyc_status: record.kyc_status,
        cdd_level: record.cdd_level,
        kyc_expiry_date: record.kyc_expiry_date,
        next_review_date: record.next_review_date,
      },
    };
  }));

  server.registerTool('chainapi_me_list_documents', {
    description: 'List KYC documents uploaded by the authenticated customer.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: customersDocumentsService.list(tenantId, customerId) })));

  server.registerTool('chainapi_me_upload_document', {
    description: 'Upload a KYC document for the authenticated customer. Verification is performed by the tenant compliance team.',
    inputSchema: {
      document_type: z.enum(['passport', 'national_id', 'driving_license', 'residence_permit', 'utility_bill', 'bank_statement', 'company_reg_cert', 'articles_of_association', 'trust_deed', 'power_of_attorney', 'tax_cert', 'financial_statement', 'source_of_funds_letter', 'source_of_wealth_letter', 'selfie', 'other']),
      document_subtype: z.string().nullable().optional(),
      storage_ref: z.string().min(1),
      storage_system: z.string().min(1),
      issuing_country: z.string().length(2).nullable().optional(),
      issuing_authority: z.string().nullable().optional(),
      issued_date: z.string().nullable().optional(),
      expiry_date: z.string().nullable().optional(),
      document_number: z.string().nullable().optional(),
      file_hash: z.string().nullable().optional(),
    },
    annotations: write,
  }, async (input: any) => safeTool(() => ({
    data: customersDocumentsService.create(tenantId, customerId, {
      ...input,
      verification_status: 'pending',
      uploaded_by: customerId,
    }),
  })));
}
