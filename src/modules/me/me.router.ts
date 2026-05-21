/// <reference path="../../types/express.d.ts" />
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { customersService } from '../customers/customers.service';
import { depositAddressService } from '../customers/deposit-address.service';
import { withdrawalsService } from '../withdrawals/withdrawals.service';
import { customersProfileService } from '../customers/customers-profile.service';
import { customersContactService } from '../customers/customers-contact.service';
import { customersDocumentsService } from '../customers/customers-documents.service';
import { customersAmlKycService } from '../customers/customers-aml-kyc.service';

export const meRouter = Router();

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const withdrawalSchema = z.object({
  toAddress: z.string().min(1),
  amountSats: z.string().regex(/^\d+$/, 'amountSats must be a positive integer string'),
  idempotencyKey: z.string().optional(),
});

function ctx(req: Request): { tenantId: string; customerId: string } {
  return {
    tenantId: (req as any).tenantId as string,
    customerId: (req as any).customerId as string,
  };
}

// GET /v1/me
meRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const customer = customersService.getById(tenantId, customerId);
    res.json({ data: customer });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/balances
meRouter.get('/balances', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const balances = customersService.getBalances(tenantId, customerId);
    res.json({ data: balances });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/deposits
meRouter.get('/deposits', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const query = listQuerySchema.parse(req.query);
    const result = customersService.getDeposits(tenantId, customerId, query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/addresses
meRouter.get('/addresses', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const query = listQuerySchema.parse(req.query);
    const result = customersService.getAddresses(tenantId, customerId, query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/me/deposit-address
meRouter.post('/deposit-address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const result = await depositAddressService.generateForCustomer(tenantId, customerId);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// POST /v1/me/withdrawals
meRouter.post('/withdrawals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const body = withdrawalSchema.parse(req.body);
    const withdrawal = await withdrawalsService.create(tenantId, customerId, {
      toAddress: body.toAddress,
      amountSats: body.amountSats,
      idempotencyKey: body.idempotencyKey,
    });
    res.status(201).json({ data: withdrawal });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/withdrawals
meRouter.get('/withdrawals', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const query = listQuerySchema.parse(req.query);
    const result = withdrawalsService.list(tenantId, customerId, query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/withdrawals/:withdrawalId
meRouter.get('/withdrawals/:withdrawalId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId } = ctx(req);
    const withdrawal = withdrawalsService.getById(tenantId, req.params['withdrawalId']!);
    res.json({ data: withdrawal });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/profile
meRouter.get('/profile', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    res.json({ data: customersProfileService.get(tenantId, customerId) });
  } catch (err) {
    next(err);
  }
});

const naturalPersonSchema = z.object({
  partyType: z.literal('natural_person'),
  person_type: z.enum(['natural', 'sole_proprietor']),
  given_name: z.string().min(1).max(200),
  family_name: z.string().min(1).max(200),
  middle_name: z.string().max(200).nullable().optional(),
  date_of_birth: z.string().nullable().optional(),
  place_of_birth: z.string().nullable().optional(),
  nationalities: z.array(z.string()).nullable().optional(),
  country_of_residence: z.string().length(2).nullable().optional(),
  occupation: z.string().max(200).nullable().optional(),
  employer_name: z.string().max(200).nullable().optional(),
  employer_country: z.string().length(2).nullable().optional(),
  business_name: z.string().max(200).nullable().optional(),
  business_activity: z.string().max(500).nullable().optional(),
  gender: z.enum(['male', 'female', 'other', 'not_stated']).nullable().optional(),
});

const legalEntitySchema = z.object({
  partyType: z.literal('legal_entity'),
  entity_subtype: z.enum(['company', 'foundation', 'ngo', 'trust', 'partnership', 'public_entity', 'other']),
  entity_subtype_other: z.string().nullable().optional(),
  legal_name: z.string().min(1).max(500),
  trade_name: z.string().nullable().optional(),
  country_of_incorporation: z.string().length(2),
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
});

const profileSchema = z.discriminatedUnion('partyType', [naturalPersonSchema, legalEntitySchema]);

// PUT /v1/me/profile
meRouter.put('/profile', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const body = profileSchema.parse(req.body);
    res.json({ data: customersProfileService.upsert(tenantId, customerId, body as any) });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/contact
meRouter.get('/contact', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    res.json({ data: customersContactService.get(tenantId, customerId) });
  } catch (err) {
    next(err);
  }
});

const contactSchema = z.object({
  email: z.string().email().nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  email_verified: z.boolean().optional(),
  phone_verified: z.boolean().optional(),
  preferred_language: z.string().max(10).nullable().optional(),
  addresses: z.array(z.object({
    type: z.enum(['registered', 'correspondence', 'residential', 'operational']),
    line1: z.string().min(1),
    line2: z.string().nullable().optional(),
    city: z.string().min(1),
    postal_code: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    country: z.string().length(2),
    is_primary: z.boolean().default(false),
    valid_from: z.string().nullable().optional(),
    valid_until: z.string().nullable().optional(),
  })).nullable().optional(),
});

// PUT /v1/me/contact
meRouter.put('/contact', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const body = contactSchema.parse(req.body);
    res.json({ data: customersContactService.upsert(tenantId, customerId, body as any) });
  } catch (err) {
    next(err);
  }
});

// GET /v1/me/kyc-status  — read-only view of own KYC status
meRouter.get('/kyc-status', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const record = customersAmlKycService.get(tenantId, customerId);
    if (!record) { res.json({ data: { kyc_status: 'not_started', cdd_level: 'standard' } }); return; }
    res.json({
      data: {
        kyc_status: record.kyc_status,
        cdd_level: record.cdd_level,
        kyc_expiry_date: record.kyc_expiry_date,
        next_review_date: record.next_review_date,
      },
    });
  } catch (err) {
    next(err);
  }
});

const meDocumentSchema = z.object({
  document_type: z.enum(['passport', 'national_id', 'driving_license', 'proof_of_address', 'bank_statement', 'company_certificate', 'articles_of_association', 'trust_deed', 'foundation_charter', 'ubo_declaration', 'power_of_attorney', 'tax_certificate', 'financial_statements', 'aml_questionnaire', 'regulatory_license', 'other']),
  document_subtype: z.string().nullable().optional(),
  storage_ref: z.string().min(1),
  storage_system: z.string().min(1),
  issuing_country: z.string().length(2).nullable().optional(),
  issuing_authority: z.string().nullable().optional(),
  issued_date: z.string().nullable().optional(),
  expiry_date: z.string().nullable().optional(),
  document_number: z.string().nullable().optional(),
  file_hash: z.string().nullable().optional(),
});

// GET /v1/me/documents
meRouter.get('/documents', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    res.json({ data: customersDocumentsService.list(tenantId, customerId) });
  } catch (err) {
    next(err);
  }
});

// POST /v1/me/documents — customer uploads; verification_status always starts as 'pending'
meRouter.post('/documents', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, customerId } = ctx(req);
    const body = meDocumentSchema.parse(req.body);
    const doc = customersDocumentsService.create(tenantId, customerId, {
      ...body,
      verification_status: 'pending',
      uploaded_by: customerId,
    });
    res.status(201).json({ data: doc });
  } catch (err) {
    next(err);
  }
});
