import request from 'supertest';
import { bootstrapApp, AUTH, teardownDb } from './helpers';

const app = bootstrapApp();

afterAll(() => teardownDb());

describe('POST /v1/customers', () => {
  it('creates a customer with no body', async () => {
    const res = await request(app).post('/v1/customers').set(AUTH).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.id).toMatch(/^cust_/);
    expect(res.body.data.status).toBe('active');
  });

  it('creates a customer with reference and metadata', async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'user-abc-123', metadata: { plan: 'pro' } });
    expect(res.status).toBe(201);
    expect(res.body.data.reference).toBe('user-abc-123');
    expect(res.body.data.metadata).toEqual({ plan: 'pro' });
  });

  it('rejects duplicate reference', async () => {
    await request(app).post('/v1/customers').set(AUTH).send({ reference: 'dup-ref-001' });
    const res = await request(app).post('/v1/customers').set(AUTH).send({ reference: 'dup-ref-001' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects missing auth', async () => {
    const res = await request(app).post('/v1/customers').send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/customers', () => {
  beforeAll(async () => {
    await request(app).post('/v1/customers').set(AUTH).send({ reference: 'list-test-1' });
    await request(app).post('/v1/customers').set(AUTH).send({ reference: 'list-test-2' });
  });

  it('returns paginated list', async () => {
    const res = await request(app).get('/v1/customers').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination).toBeDefined();
  });

  it('respects limit', async () => {
    const res = await request(app).get('/v1/customers?limit=1').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.pagination.nextCursor).toBeTruthy();
  });

  it('filters by status=active', async () => {
    const res = await request(app).get('/v1/customers?status=active').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.every((c: any) => c.status === 'active')).toBe(true);
  });
});

describe('GET /v1/customers/:customerId', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'get-by-id-test', metadata: { tier: 'gold' } });
    customerId = res.body.data.id;
  });

  it('returns customer by id', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(customerId);
    expect(res.body.data.reference).toBe('get-by-id-test');
    expect(res.body.data.metadata).toEqual({ tier: 'gold' });
  });

  it('returns 404 for non-existent customer', async () => {
    const res = await request(app).get('/v1/customers/cust_nonexistent').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /v1/customers/:customerId', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'patch-test' });
    customerId = res.body.data.id;
  });

  it('updates customer reference', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}`)
      .set(AUTH)
      .send({ reference: 'patch-test-updated' });
    expect(res.status).toBe(200);
    expect(res.body.data.reference).toBe('patch-test-updated');
  });

  it('updates customer status', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}`)
      .set(AUTH)
      .send({ status: 'frozen' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('frozen');
  });

  it('rejects invalid status', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}`)
      .set(AUTH)
      .send({ status: 'invalid_status' });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/customers/:customerId/disable', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'disable-test' });
    customerId = res.body.data.id;
  });

  it('disables customer', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/disable`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('disabled');
  });
});

describe('GET /v1/customers/:customerId/balances', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'balances-test' });
    customerId = res.body.data.id;
  });

  it('returns 200 with array', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/balances`).set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns exactly one entry per asset_id — not one per ledger account', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/balances`).set(AUTH);
    expect(res.status).toBe(200);
    const assetIds = res.body.data.map((b: any) => b.asset_id);
    const unique = new Set(assetIds);
    expect(unique.size).toBe(assetIds.length);
  });

  it('each balance entry has pending, settled, total fields', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/balances`).set(AUTH);
    expect(res.status).toBe(200);
    for (const balance of res.body.data) {
      expect(balance).toHaveProperty('asset_id');
      expect(balance).toHaveProperty('pending');
      expect(balance).toHaveProperty('settled');
      expect(balance).toHaveProperty('total');
    }
  });

  it('returns 404 for non-existent customer', async () => {
    const res = await request(app).get('/v1/customers/cust_nonexistent/balances').set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/customers/:customerId/deposits', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app).post('/v1/customers').set(AUTH).send({ reference: 'deposits-sub-test' });
    customerId = res.body.data.id;
  });

  it('returns empty deposits list for a new customer', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/deposits`).set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toBeDefined();
  });

  it('filters by status without error', async () => {
    const res = await request(app)
      .get(`/v1/customers/${customerId}/deposits?status=confirmed`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 404 for non-existent customer', async () => {
    const res = await request(app).get('/v1/customers/cust_doesnotexist/deposits').set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/customers/:customerId/addresses', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app).post('/v1/customers').set(AUTH).send({ reference: 'addresses-sub-test' });
    customerId = res.body.data.id;
  });

  it('returns empty address list for a new customer', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/addresses`).set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toBeDefined();
  });

  it('returns 404 for non-existent customer', async () => {
    const res = await request(app).get('/v1/customers/cust_doesnotexist/addresses').set(AUTH);
    expect(res.status).toBe(404);
  });
});

// ============================================================
// GET /v1/customers — extended search filters
// ============================================================

describe('GET /v1/customers — search filters', () => {
  let custA: string; // natural person with profile, contact, identifier
  let custB: string; // legal entity with profile, relationship

  beforeAll(async () => {
    // Customer A — natural person
    const rA = await request(app).post('/v1/customers').set(AUTH).send({
      reference: 'search-ref-alpha',
      party_type: 'natural_person',
      display_name: 'Jan Kowalski',
      country_of_origin: 'PL',
    });
    custA = rA.body.data.id;

    await request(app).put(`/v1/customers/${custA}/profile`).set(AUTH).send({
      partyType: 'natural_person',
      person_type: 'individual',
      given_name: 'Jan',
      family_name: 'Kowalski',
      middle_name: 'Adam',
    });
    await request(app).put(`/v1/customers/${custA}/contact`).set(AUTH).send({
      email: 'jan.kowalski@example.com', phone: '+48123456789',
    });
    await request(app).post(`/v1/customers/${custA}/identifiers`).set(AUTH).send({
      type: 'passport', value: 'AB123456',
    });

    // Customer B — legal entity
    const rB = await request(app).post('/v1/customers').set(AUTH).send({
      reference: 'search-ref-beta',
      party_type: 'legal_entity',
      display_name: 'Acme Sp. z o.o.',
      country_of_origin: 'DE',
    });
    custB = rB.body.data.id;

    await request(app).put(`/v1/customers/${custB}/profile`).set(AUTH).send({
      partyType: 'legal_entity',
      entity_subtype: 'company',
      legal_name: 'Acme Sp. z o.o.',
      trade_name: 'Acme',
      country_of_incorporation: 'DE',
    });
    await request(app).post(`/v1/customers/${custB}/relationships`).set(AUTH).send({
      relationship_type: 'beneficial_owner',
      external_party: {
        display_name: 'Hans Mueller',
        party_type: 'natural_person',
        country_of_origin: 'DE',
        identifier_type: 'passport',
        identifier_value: 'DE987654',
      },
    });
  });

  // --- customers table ---

  it('filters by id (exact)', async () => {
    const res = await request(app).get(`/v1/customers?id=${custA}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(custA);
  });

  it('filters by reference (exact substring)', async () => {
    const res = await request(app).get('/v1/customers?reference=search-ref-alpha').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('filters by reference with wildcard prefix', async () => {
    const res = await request(app).get('/v1/customers?reference=search-ref-*').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(true);
  });

  it('filters by display_name substring', async () => {
    const res = await request(app).get('/v1/customers?display_name=Kowalski').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(false);
  });

  it('filters by country_of_origin (exact)', async () => {
    const res = await request(app).get('/v1/customers?country_of_origin=PL').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(false);
  });

  it('filters by party_type', async () => {
    const res = await request(app).get('/v1/customers?party_type=legal_entity').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.every((c: any) => c.party_type === 'legal_entity')).toBe(true);
  });

  // --- profile ---

  it('filters by profile_given_name', async () => {
    const res = await request(app).get('/v1/customers?profile_given_name=Jan').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('filters by profile_family_name with wildcard', async () => {
    const res = await request(app).get('/v1/customers?profile_family_name=Kowal*').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('filters by profile_middle_name', async () => {
    const res = await request(app).get('/v1/customers?profile_middle_name=Adam').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('filters by profile_business_name matches legal_name', async () => {
    const res = await request(app).get('/v1/customers?profile_business_name=Acme').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(true);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(false);
  });

  // --- contact ---

  it('filters by contact_email', async () => {
    const res = await request(app).get('/v1/customers?contact_email=jan.kowalski%40example.com').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('filters by contact_email with wildcard', async () => {
    const res = await request(app).get('/v1/customers?contact_email=*%40example.com').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('filters by contact_phone', async () => {
    const res = await request(app).get('/v1/customers?contact_phone=%2B48*').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  // --- identifiers ---

  it('filters by identifier_type', async () => {
    const res = await request(app).get('/v1/customers?identifier_type=passport').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('filters by identifier_value', async () => {
    const res = await request(app).get('/v1/customers?identifier_value=AB123456').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('filters by identifier_type AND identifier_value (AND pair)', async () => {
    const res = await request(app)
      .get('/v1/customers?identifier_type=passport&identifier_value=AB123456')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('identifier_type + wrong value returns no match', async () => {
    const res = await request(app)
      .get('/v1/customers?identifier_type=passport&identifier_value=ZZZZZZ')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(false);
  });

  it('identifier_type is case-insensitive (Passport matches passport)', async () => {
    const res = await request(app).get('/v1/customers?identifier_type=Passport').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  it('identifier_type is case-insensitive (PASSPORT matches passport)', async () => {
    const res = await request(app)
      .get('/v1/customers?identifier_type=PASSPORT&identifier_value=AB123456')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
  });

  // --- relationships ---

  it('filters by rel_display_name', async () => {
    const res = await request(app).get('/v1/customers?rel_display_name=Hans Mueller').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(true);
  });

  it('filters by rel_display_name with wildcard', async () => {
    const res = await request(app).get('/v1/customers?rel_display_name=Hans*').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(true);
  });

  it('filters by rel_identifier_type', async () => {
    const res = await request(app).get('/v1/customers?rel_identifier_type=passport').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(true);
  });

  it('filters by rel_identifier_value', async () => {
    const res = await request(app).get('/v1/customers?rel_identifier_value=DE987654').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(true);
  });

  it('rel_identifier_type AND rel_identifier_value pair', async () => {
    const res = await request(app)
      .get('/v1/customers?rel_identifier_type=passport&rel_identifier_value=DE987654')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(true);
  });

  it('rel_identifier_type is case-insensitive (Passport matches passport)', async () => {
    const res = await request(app).get('/v1/customers?rel_identifier_type=Passport').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(true);
  });

  // --- AND logic (cross-table) ---

  it('AND: party_type + profile_given_name only returns correct customer', async () => {
    const res = await request(app)
      .get('/v1/customers?party_type=natural_person&profile_given_name=Jan')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(true);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(false);
  });

  it('AND: contradicting filters return empty', async () => {
    const res = await request(app)
      .get('/v1/customers?party_type=natural_person&profile_business_name=Acme')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === custA)).toBe(false);
    expect(res.body.data.some((c: any) => c.id === custB)).toBe(false);
  });
});
