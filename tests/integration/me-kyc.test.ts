/**
 * Integration tests for /v1/me KYC self-service endpoints.
 *
 * Covers:
 * - GET/PUT /v1/me/profile   — natural person and legal entity profiles
 * - GET/PUT /v1/me/contact   — email, phone, postal addresses
 * - GET     /v1/me/kyc-status — read-only compliance view (no sensitive fields)
 * - GET     /v1/me/documents  — list
 * - POST    /v1/me/documents  — upload; verification_status always pending
 * - Auth guard on every endpoint
 * - Customer cannot override verification_status
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr } from './helpers';

const app = bootstrapApp();
afterAll(() => teardownDb());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function createTenantWithKey() {
  const t = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `me-kyc-${Date.now()}`, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
  const tenantId = t.body.data.id;
  const k = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'key' });
  return { tenantId, auth: { Authorization: `Bearer ${k.body.data.apiKey}` } };
}

async function customerSession(
  auth: Record<string, string>,
  partyType: 'natural_person' | 'legal_entity' = 'natural_person',
): Promise<{ customerId: string; token: string }> {
  const c = await request(app)
    .post('/v1/customers')
    .set(auth)
    .send({ reference: `me_kyc_${Date.now()}`, party_type: partyType });
  expect(c.status).toBe(201);
  const s = await request(app).post(`/v1/customers/${c.body.data.id}/sessions`).set(auth);
  expect(s.status).toBe(201);
  return { customerId: c.body.data.id, token: s.body.data.accessToken };
}

// ---------------------------------------------------------------------------
// GET /v1/me/profile
// ---------------------------------------------------------------------------
describe('GET /v1/me/profile', () => {
  it('returns null before any profile is set', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);
    const res = await request(app).get('/v1/me/profile').set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('returns 401 without token', async () => {
    expect((await request(app).get('/v1/me/profile')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/me/profile — natural_person
// ---------------------------------------------------------------------------
describe('PUT /v1/me/profile — natural_person', () => {
  it('creates a profile and returns it', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app)
      .put('/v1/me/profile')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        partyType: 'natural_person',
        person_type: 'natural',
        given_name: 'Jan',
        family_name: 'Kowalski',
        date_of_birth: '1985-03-15',
        nationalities: ['PL'],
        country_of_residence: 'PL',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.given_name).toBe('Jan');
    expect(res.body.data.family_name).toBe('Kowalski');
    expect(res.body.data.date_of_birth).toBe('1985-03-15');
  });

  it('subsequent GET returns the saved profile', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    await request(app)
      .put('/v1/me/profile')
      .set({ Authorization: `Bearer ${token}` })
      .send({ partyType: 'natural_person', person_type: 'natural', given_name: 'Anna', family_name: 'Nowak' });

    const res = await request(app).get('/v1/me/profile').set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.data.given_name).toBe('Anna');
    expect(res.body.data.family_name).toBe('Nowak');
  });

  it('update overwrites existing profile fields', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    await request(app)
      .put('/v1/me/profile')
      .set({ Authorization: `Bearer ${token}` })
      .send({ partyType: 'natural_person', person_type: 'natural', given_name: 'Old', family_name: 'Name' });

    const res = await request(app)
      .put('/v1/me/profile')
      .set({ Authorization: `Bearer ${token}` })
      .send({ partyType: 'natural_person', person_type: 'natural', given_name: 'New', family_name: 'Name' });

    expect(res.status).toBe(200);
    expect(res.body.data.given_name).toBe('New');
  });

  it('returns 400 for missing required fields (no given_name)', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app)
      .put('/v1/me/profile')
      .set({ Authorization: `Bearer ${token}` })
      .send({ partyType: 'natural_person', person_type: 'natural', family_name: 'Nowak' });

    expect(res.status).toBe(400);
  });

  it('returns 401 without token', async () => {
    const res = await request(app)
      .put('/v1/me/profile')
      .send({ partyType: 'natural_person', person_type: 'natural', given_name: 'X', family_name: 'Y' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/me/profile — legal_entity
// ---------------------------------------------------------------------------
describe('PUT /v1/me/profile — legal_entity', () => {
  it('creates a legal entity profile for a legal_entity customer', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth, 'legal_entity');

    const res = await request(app)
      .put('/v1/me/profile')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        partyType: 'legal_entity',
        entity_subtype: 'company',
        legal_name: 'Example Sp. z o.o.',
        country_of_incorporation: 'PL',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.legal_name).toBe('Example Sp. z o.o.');
    expect(res.body.data.country_of_incorporation).toBe('PL');
  });

  it('returns 400 for missing legal_name', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth, 'legal_entity');

    const res = await request(app)
      .put('/v1/me/profile')
      .set({ Authorization: `Bearer ${token}` })
      .send({ partyType: 'legal_entity', entity_subtype: 'company', country_of_incorporation: 'PL' });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/contact
// ---------------------------------------------------------------------------
describe('GET /v1/me/contact', () => {
  it('returns null before any contact is set', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);
    const res = await request(app).get('/v1/me/contact').set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('returns 401 without token', async () => {
    expect((await request(app).get('/v1/me/contact')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PUT /v1/me/contact
// ---------------------------------------------------------------------------
describe('PUT /v1/me/contact', () => {
  it('creates contact with email, phone and address', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app)
      .put('/v1/me/contact')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        email: 'jan@example.com',
        phone: '+48600100200',
        addresses: [{
          type: 'residential',
          line1: 'ul. Marszalkowska 1',
          city: 'Warszawa',
          postal_code: '00-001',
          country: 'PL',
          is_primary: true,
        }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('jan@example.com');
    expect(res.body.data.phone).toBe('+48600100200');
    expect(Array.isArray(res.body.data.addresses)).toBe(true);
    expect(res.body.data.addresses[0].city).toBe('Warszawa');
  });

  it('GET after PUT returns saved contact', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    await request(app)
      .put('/v1/me/contact')
      .set({ Authorization: `Bearer ${token}` })
      .send({ email: 'saved@example.com' });

    const res = await request(app).get('/v1/me/contact').set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('saved@example.com');
  });

  it('subsequent PUT updates email', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    await request(app)
      .put('/v1/me/contact')
      .set({ Authorization: `Bearer ${token}` })
      .send({ email: 'first@example.com' });

    const res = await request(app)
      .put('/v1/me/contact')
      .set({ Authorization: `Bearer ${token}` })
      .send({ email: 'updated@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('updated@example.com');
  });

  it('returns 400 for invalid email format', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app)
      .put('/v1/me/contact')
      .set({ Authorization: `Bearer ${token}` })
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
  });

  it('returns 401 without token', async () => {
    expect((await request(app).put('/v1/me/contact').send({ email: 'x@x.com' })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/kyc-status
// ---------------------------------------------------------------------------
describe('GET /v1/me/kyc-status', () => {
  it('returns not_started status for a new customer', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app).get('/v1/me/kyc-status').set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.body.data.kyc_status).toBe('not_started');
    expect(res.body.data.cdd_level).toBeDefined();
  });

  it('reflects tenant compliance approval', async () => {
    const { auth } = await createTenantWithKey();
    const { customerId, token } = await customerSession(auth);

    await request(app)
      .put(`/v1/customers/${customerId}/aml-kyc`)
      .set(auth)
      .send({ kyc_status: 'verified', kyc_verified_at: '2025-01-01T12:00:00Z' });

    const res = await request(app).get('/v1/me/kyc-status').set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.body.data.kyc_status).toBe('verified');
  });

  it('does NOT expose sensitive compliance fields to the customer', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app).get('/v1/me/kyc-status').set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.body.data.aml_risk_level).toBeUndefined();
    expect(res.body.data.pep_status).toBeUndefined();
    expect(res.body.data.sanctions_status).toBeUndefined();
    expect(res.body.data.aml_risk_score).toBeUndefined();
  });

  it('returns 401 without token', async () => {
    expect((await request(app).get('/v1/me/kyc-status')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/documents
// ---------------------------------------------------------------------------
describe('GET /v1/me/documents', () => {
  it('returns empty array before any upload', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app).get('/v1/me/documents').set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
  });

  it('returns 401 without token', async () => {
    expect((await request(app).get('/v1/me/documents')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/me/documents
// ---------------------------------------------------------------------------
describe('POST /v1/me/documents', () => {
  it('uploads a document with verification_status set to pending', async () => {
    const { auth } = await createTenantWithKey();
    const { customerId, token } = await customerSession(auth);

    const res = await request(app)
      .post('/v1/me/documents')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        document_type: 'passport',
        storage_ref: 's3://kyc/tenant/passport.pdf',
        storage_system: 's3',
        issuing_country: 'PL',
        expiry_date: '2030-12-31',
        document_number: 'AB1234567',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.document_type).toBe('passport');
    expect(res.body.data.verification_status).toBe('pending');
    expect(res.body.data.customer_id).toBe(customerId);
  });

  it('uploaded document appears in the GET list', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    await request(app)
      .post('/v1/me/documents')
      .set({ Authorization: `Bearer ${token}` })
      .send({ document_type: 'national_id', storage_ref: 's3://kyc/id.jpg', storage_system: 's3' });

    const listRes = await request(app).get('/v1/me/documents').set({ Authorization: `Bearer ${token}` });

    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].document_type).toBe('national_id');
  });

  it('customer cannot self-approve — verification_status is always pending regardless of body', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app)
      .post('/v1/me/documents')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        document_type: 'proof_of_address',
        storage_ref: 's3://kyc/addr.pdf',
        storage_system: 's3',
        verification_status: 'verified', // ignored — stripped by Zod
      });

    expect(res.status).toBe(201);
    expect(res.body.data.verification_status).toBe('pending');
  });

  it('returns 400 for missing storage_ref', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app)
      .post('/v1/me/documents')
      .set({ Authorization: `Bearer ${token}` })
      .send({ document_type: 'passport', storage_system: 's3' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown document_type', async () => {
    const { auth } = await createTenantWithKey();
    const { token } = await customerSession(auth);

    const res = await request(app)
      .post('/v1/me/documents')
      .set({ Authorization: `Bearer ${token}` })
      .send({ document_type: 'selfie', storage_ref: 's3://x', storage_system: 's3' });

    expect(res.status).toBe(400);
  });

  it('returns 401 without token', async () => {
    const res = await request(app)
      .post('/v1/me/documents')
      .send({ document_type: 'passport', storage_ref: 'x', storage_system: 's3' });
    expect(res.status).toBe(401);
  });
});
