/**
 * Integration tests for individual MCP tool calls — tenant and customer KYC tools.
 *
 * Covers:
 * - New KYC tools appear in tools/list for the correct context
 * - chainapi_get_customer_profile / chainapi_upsert_customer_profile
 * - chainapi_list_customer_identifiers / chainapi_add_customer_identifier
 * - chainapi_get_customer_aml_kyc / chainapi_upsert_customer_aml_kyc
 * - chainapi_get_customer_data_governance / chainapi_upsert_customer_data_governance
 * - chainapi_get_customer_contact / chainapi_upsert_customer_contact
 * - chainapi_list_customer_documents / chainapi_add_customer_document
 * - chainapi_me_get_kyc_profile / chainapi_me_upsert_kyc_profile
 * - chainapi_me_get_contact / chainapi_me_upsert_contact
 * - chainapi_me_get_kyc_status
 * - chainapi_me_list_documents / chainapi_me_upload_document
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, AUTH, TEST_TENANT_ID, teardownDb } from './helpers';

const app = bootstrapApp();
afterAll(() => teardownDb());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

function mcpPost(path: string) {
  return request(app)
    .post(path)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
}

async function tenantTool(name: string, args: Record<string, unknown> = {}) {
  return mcpPost('/mcp/tenant')
    .set(AUTH)
    .send(rpc(1, 'tools/call', { name, arguments: args }));
}

async function customerTool(token: string, name: string, args: Record<string, unknown> = {}) {
  return mcpPost('/mcp/customer')
    .set({ Authorization: `Bearer ${token}` })
    .send(rpc(1, 'tools/call', { name, arguments: args }));
}

async function createCustomer(partyType: 'natural_person' | 'legal_entity' = 'natural_person'): Promise<string> {
  const res = await request(app)
    .post('/v1/customers')
    .set(AUTH)
    .send({ reference: `mcp_tools_${Date.now()}`, party_type: partyType });
  expect(res.status).toBe(201);
  return res.body.data.id;
}

async function issueSession(customerId: string): Promise<string> {
  const res = await request(app).post(`/v1/customers/${customerId}/sessions`).set(AUTH);
  expect(res.status).toBe(201);
  return res.body.data.accessToken;
}

// ---------------------------------------------------------------------------
// tools/list — verify new tools are registered
// ---------------------------------------------------------------------------
describe('tools/list — KYC tools registration', () => {
  it('tenant tools list includes all new KYC tools', async () => {
    const res = await mcpPost('/mcp/tenant').set(AUTH).send(rpc(1, 'tools/list'));
    expect(res.status).toBe(200);
    const names: string[] = res.body.result.tools.map((t: any) => t.name);

    const expected = [
      'chainapi_get_customer_profile',
      'chainapi_upsert_customer_profile',
      'chainapi_list_customer_identifiers',
      'chainapi_add_customer_identifier',
      'chainapi_update_customer_identifier',
      'chainapi_delete_customer_identifier',
      'chainapi_list_customer_relationships',
      'chainapi_add_customer_relationship',
      'chainapi_update_customer_relationship',
      'chainapi_delete_customer_relationship',
      'chainapi_get_customer_aml_kyc',
      'chainapi_upsert_customer_aml_kyc',
      'chainapi_get_customer_data_governance',
      'chainapi_upsert_customer_data_governance',
      'chainapi_get_customer_contact',
      'chainapi_upsert_customer_contact',
      'chainapi_list_customer_documents',
      'chainapi_add_customer_document',
      'chainapi_update_customer_document',
      'chainapi_delete_customer_document',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('customer tools list includes all new KYC self-service tools', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);

    const res = await mcpPost('/mcp/customer')
      .set({ Authorization: `Bearer ${token}` })
      .send(rpc(1, 'tools/list'));
    expect(res.status).toBe(200);
    const names: string[] = res.body.result.tools.map((t: any) => t.name);

    const expected = [
      'chainapi_me_get_kyc_profile',
      'chainapi_me_upsert_kyc_profile',
      'chainapi_me_get_contact',
      'chainapi_me_upsert_contact',
      'chainapi_me_get_kyc_status',
      'chainapi_me_list_documents',
      'chainapi_me_upload_document',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
    // Tenant-only tools must NOT appear in customer context
    expect(names).not.toContain('chainapi_get_customer_aml_kyc');
    expect(names).not.toContain('chainapi_upsert_customer_aml_kyc');
  });
});

// ---------------------------------------------------------------------------
// Tenant tool: customer profile
// ---------------------------------------------------------------------------
describe('chainapi_get/upsert_customer_profile', () => {
  it('get returns null before profile is set', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_get_customer_profile', { customerId });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data).toBeNull();
  });

  it('upsert creates a natural person profile', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_upsert_customer_profile', {
      customerId,
      partyType: 'natural_person',
      person_type: 'natural',
      given_name: 'Jan',
      family_name: 'Kowalski',
      date_of_birth: '1980-06-15',
    });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data.given_name).toBe('Jan');
    expect(res.body.result.isError).toBeUndefined();
  });

  it('get returns profile after upsert', async () => {
    const customerId = await createCustomer();
    await tenantTool('chainapi_upsert_customer_profile', {
      customerId,
      partyType: 'natural_person',
      person_type: 'natural',
      given_name: 'Maria',
      family_name: 'Nowak',
    });
    const res = await tenantTool('chainapi_get_customer_profile', { customerId });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data.family_name).toBe('Nowak');
  });
});

// ---------------------------------------------------------------------------
// Tenant tool: identifiers
// ---------------------------------------------------------------------------
describe('chainapi_list/add_customer_identifier', () => {
  it('list returns empty array for new customer', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_list_customer_identifiers', { customerId });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data).toEqual([]);
  });

  it('add creates an identifier', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_add_customer_identifier', {
      customerId,
      type: 'passport',
      value: 'AB1234567',
      issuing_country: 'PL',
      valid_until: '2030-12-31',
    });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data.value).toBe('AB1234567');
    expect(res.body.result.structuredContent.data.type).toBe('passport');
  });

  it('added identifier appears in list', async () => {
    const customerId = await createCustomer();
    await tenantTool('chainapi_add_customer_identifier', {
      customerId, type: 'tax_id', value: '1234567890', issuing_country: 'PL',
    });
    const res = await tenantTool('chainapi_list_customer_identifiers', { customerId });
    expect(res.body.result.structuredContent.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant tool: AML/KYC
// ---------------------------------------------------------------------------
describe('chainapi_get/upsert_customer_aml_kyc', () => {
  it('get returns auto-provisioned record with default values', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_get_customer_aml_kyc', { customerId });
    expect(res.status).toBe(200);
    const data = res.body.result.structuredContent.data;
    expect(data.kyc_status).toBe('not_started');
    expect(data.cdd_level).toBe('standard');
    expect(data.aml_risk_level).toBe('unassessed');
    expect(data.pep_status).toBe('not_pep');
    expect(data.sanctions_status).toBe('clear');
  });

  it('upsert updates KYC status and risk level', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_upsert_customer_aml_kyc', {
      customerId,
      kyc_status: 'verified',
      aml_risk_level: 'low',
      source_of_funds: ['salary', 'savings'],
    });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data.kyc_status).toBe('verified');
    expect(res.body.result.structuredContent.data.aml_risk_level).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// Tenant tool: data governance
// ---------------------------------------------------------------------------
describe('chainapi_get/upsert_customer_data_governance', () => {
  it('get returns auto-provisioned record', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_get_customer_data_governance', { customerId });
    expect(res.status).toBe(200);
    const data = res.body.result.structuredContent.data;
    expect(data.data_classification).toBe('confidential');
    expect(data.lawful_basis).toBe('legal_obligation');
    expect(data.version).toBe(1);
  });

  it('upsert increments version counter on every write', async () => {
    const customerId = await createCustomer();
    await tenantTool('chainapi_upsert_customer_data_governance', {
      customerId, retention_policy: '5y_after_offboarding',
    });
    const res = await tenantTool('chainapi_get_customer_data_governance', { customerId });
    expect(res.body.result.structuredContent.data.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tenant tool: contact
// ---------------------------------------------------------------------------
describe('chainapi_get/upsert_customer_contact', () => {
  it('get returns null for new customer', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_get_customer_contact', { customerId });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data).toBeNull();
  });

  it('upsert creates contact', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_upsert_customer_contact', {
      customerId,
      email: 'compliance@example.com',
      phone: '+48600000001',
    });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data.email).toBe('compliance@example.com');
  });
});

// ---------------------------------------------------------------------------
// Tenant tool: documents
// ---------------------------------------------------------------------------
describe('chainapi_list/add_customer_document', () => {
  it('list returns empty array for new customer', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_list_customer_documents', { customerId });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data).toEqual([]);
  });

  it('add creates a document with given verification_status', async () => {
    const customerId = await createCustomer();
    const res = await tenantTool('chainapi_add_customer_document', {
      customerId,
      document_type: 'passport',
      storage_ref: 's3://kyc/mcp-test/doc.pdf',
      storage_system: 's3',
      verification_status: 'verified',
      verified_by: 'compliance_officer',
    });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data.verification_status).toBe('verified');
    expect(res.body.result.structuredContent.data.document_type).toBe('passport');
  });
});

// ---------------------------------------------------------------------------
// Customer MCP tool: kyc profile
// ---------------------------------------------------------------------------
describe('chainapi_me_get/upsert_kyc_profile', () => {
  it('get returns null before any profile', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);
    const res = await customerTool(token, 'chainapi_me_get_kyc_profile');
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data).toBeNull();
  });

  it('upsert creates and get returns the profile', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);

    const upsertRes = await customerTool(token, 'chainapi_me_upsert_kyc_profile', {
      partyType: 'natural_person',
      person_type: 'natural',
      given_name: 'Marek',
      family_name: 'Zielinski',
    });
    expect(upsertRes.status).toBe(200);

    const getRes = await customerTool(token, 'chainapi_me_get_kyc_profile');
    expect(getRes.body.result.structuredContent.data.given_name).toBe('Marek');
  });
});

// ---------------------------------------------------------------------------
// Customer MCP tool: contact
// ---------------------------------------------------------------------------
describe('chainapi_me_get/upsert_contact', () => {
  it('get returns null before contact is set', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);
    const res = await customerTool(token, 'chainapi_me_get_contact');
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data).toBeNull();
  });

  it('upsert creates contact and get returns it', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);

    await customerTool(token, 'chainapi_me_upsert_contact', { email: 'me@example.com' });
    const res = await customerTool(token, 'chainapi_me_get_contact');
    expect(res.body.result.structuredContent.data.email).toBe('me@example.com');
  });
});

// ---------------------------------------------------------------------------
// Customer MCP tool: kyc-status
// ---------------------------------------------------------------------------
describe('chainapi_me_get_kyc_status', () => {
  it('returns default status for new customer', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);
    const res = await customerTool(token, 'chainapi_me_get_kyc_status');
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data.kyc_status).toBe('not_started');
  });

  it('does not expose aml_risk_level or pep_status', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);
    const res = await customerTool(token, 'chainapi_me_get_kyc_status');
    expect(res.body.result.structuredContent.data.aml_risk_level).toBeUndefined();
    expect(res.body.result.structuredContent.data.pep_status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Customer MCP tool: documents
// ---------------------------------------------------------------------------
describe('chainapi_me_list/upload_document', () => {
  it('list returns empty array for new customer', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);
    const res = await customerTool(token, 'chainapi_me_list_documents');
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data).toEqual([]);
  });

  it('upload creates a document with pending status', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);

    const res = await customerTool(token, 'chainapi_me_upload_document', {
      document_type: 'national_id',
      storage_ref: 's3://kyc/customer/id.jpg',
      storage_system: 's3',
      issuing_country: 'PL',
    });
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data.verification_status).toBe('pending');
    expect(res.body.result.structuredContent.data.document_type).toBe('national_id');
  });

  it('uploaded document appears in list', async () => {
    const customerId = await createCustomer();
    const token = await issueSession(customerId);

    await customerTool(token, 'chainapi_me_upload_document', {
      document_type: 'driving_license',
      storage_ref: 's3://kyc/customer/dl.jpg',
      storage_system: 's3',
    });

    const res = await customerTool(token, 'chainapi_me_list_documents');
    expect(res.body.result.structuredContent.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — tool cannot access other tenant's customers
// ---------------------------------------------------------------------------
describe('Tenant isolation via MCP tools', () => {
  it('chainapi_get_customer returns error for unknown customerId', async () => {
    const res = await tenantTool('chainapi_get_customer_profile', {
      customerId: 'cust_doesnotexist',
    });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
  });
});
