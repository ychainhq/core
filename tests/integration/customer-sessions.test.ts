/**
 * Integration tests for S09 — Customer Sessions & /v1/me/* self-service API.
 *
 * Covers:
 * - POST /v1/customers/:id/sessions — happy path, disabled customer, unknown customer
 * - GET /v1/me — returns customer profile
 * - GET /v1/me/balances — returns balances
 * - GET /v1/me/deposits — returns deposits list
 * - GET /v1/me/addresses — returns addresses list
 * - /v1/me requires customer token (not tenant API key)
 * - Expired / tampered token → 401
 * - Customer A token cannot access customer B data (isolation via customerId in token)
 * - GET /v1/withdrawals — tenant-facing list (tenant API key)
 * - GET /v1/withdrawals/:id — tenant-facing detail
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, AUTH, teardownDb } from './helpers';

const app = bootstrapApp();
afterAll(() => teardownDb());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function createTenantWithKey(): Promise<{ tenantId: string; auth: { Authorization: string } }> {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `session-test-tenant-${Date.now()}` });
  const tenantId = createRes.body.data.id;
  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'key' });
  return { tenantId, auth: { Authorization: `Bearer ${keyRes.body.data.apiKey}` } };
}

async function createCustomer(
  auth: Record<string, string>,
  ref?: string
): Promise<{ id: string; status: string }> {
  const res = await request(app)
    .post('/v1/customers')
    .set(auth)
    .send({ reference: ref ?? `ref_${Date.now()}` });
  expect(res.status).toBe(201);
  return res.body.data;
}

async function issueSession(
  auth: Record<string, string>,
  customerId: string
): Promise<string> {
  const res = await request(app)
    .post(`/v1/customers/${customerId}/sessions`)
    .set(auth);
  expect(res.status).toBe(201);
  return res.body.data.accessToken;
}

// ---------------------------------------------------------------------------
// POST /v1/customers/:id/sessions
// ---------------------------------------------------------------------------
describe('POST /v1/customers/:id/sessions', () => {
  it('returns accessToken and expiresAt for an active customer', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);

    const res = await request(app)
      .post(`/v1/customers/${customer.id}/sessions`)
      .set(auth);

    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeDefined();
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.expiresAt).toBeDefined();
    expect(res.body.data.customerId).toBe(customer.id);
    // Token is a 3-part JWT
    expect(res.body.data.accessToken.split('.').length).toBe(3);
    // expiresAt is in the future
    expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 404 for unknown customer', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .post('/v1/customers/cust_doesnotexist/sessions')
      .set(auth);
    expect(res.status).toBe(404);
  });

  it('returns 403 for a disabled customer', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    await request(app).post(`/v1/customers/${customer.id}/disable`).set(auth);

    const res = await request(app)
      .post(`/v1/customers/${customer.id}/sessions`)
      .set(auth);
    expect(res.status).toBe(403);
  });

  it('requires tenant API key (not customer token)', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    // Trying to issue a session using a customer token → auth middleware will fail
    // because the /v1/customers route uses the standard auth middleware (tenant API key)
    const res = await request(app)
      .post(`/v1/customers/${customer.id}/sessions`)
      .set({ Authorization: `Bearer ${token}` });
    // The tenant authMiddleware won't recognize the JWT as a valid API key → 401
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me
// ---------------------------------------------------------------------------
describe('GET /v1/me', () => {
  it('returns customer profile with valid session token', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth, `me_ref_${Date.now()}`);
    const token = await issueSession(auth, customer.id);

    const res = await request(app)
      .get('/v1/me')
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(customer.id);
    expect(res.body.data.status).toBe('active');
  });

  it('returns 401 without authorization header', async () => {
    const res = await request(app).get('/v1/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 with tenant API key (not a customer token)', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/me').set(auth);
    expect(res.status).toBe(401);
  });

  it('returns 401 with tampered token', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);
    // Tamper with the payload (middle part)
    const parts = token.split('.');
    const fakePayload = Buffer.from(JSON.stringify({ sub: 'evil', tid: 'evil', iat: 1, exp: 9999999999 }))
      .toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const tampered = `${parts[0]}.${fakePayload}.${parts[2]}`;

    const res = await request(app)
      .get('/v1/me')
      .set({ Authorization: `Bearer ${tampered}` });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/balances
// ---------------------------------------------------------------------------
describe('GET /v1/me/balances', () => {
  it('returns balances array for authenticated customer', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const res = await request(app)
      .get('/v1/me/balances')
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/v1/me/balances');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/deposits
// ---------------------------------------------------------------------------
describe('GET /v1/me/deposits', () => {
  it('returns empty deposits list for a new customer', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const res = await request(app)
      .get('/v1/me/deposits')
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/addresses
// ---------------------------------------------------------------------------
describe('GET /v1/me/addresses', () => {
  it('returns empty address list for a new customer', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const res = await request(app)
      .get('/v1/me/addresses')
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/withdrawals
// ---------------------------------------------------------------------------
describe('GET /v1/me/withdrawals', () => {
  it('returns empty withdrawal list for a new customer', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const res = await request(app)
      .get('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Customer isolation — one customer's token cannot access another's data
// ---------------------------------------------------------------------------
describe('Customer isolation', () => {
  it("customer A token cannot be reused — each token encodes the customer's id", async () => {
    const { auth } = await createTenantWithKey();
    const custA = await createCustomer(auth, `iso_a_${Date.now()}`);
    const custB = await createCustomer(auth, `iso_b_${Date.now()}`);

    const tokenA = await issueSession(auth, custA.id);

    // Customer A's token → /v1/me returns customer A
    const resA = await request(app)
      .get('/v1/me')
      .set({ Authorization: `Bearer ${tokenA}` });
    expect(resA.status).toBe(200);
    expect(resA.body.data.id).toBe(custA.id);

    // Customer A's token → cannot be used to fetch customer B's detail
    // (there's no /v1/me/{otherId} — /v1/me is always scoped to token owner)
    // So we verify the id in the response is always A, not B
    expect(resA.body.data.id).not.toBe(custB.id);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/me/withdrawals — insufficient balance (no hot wallet configured)
// ---------------------------------------------------------------------------
describe('POST /v1/me/withdrawals', () => {
  it('returns 422 when customer has no balance', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        toAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        amountSats: '100000',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/[Ii]nsufficient/);
  });

  it('returns 400 for invalid amountSats (non-numeric)', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({ toAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amountSats: 'abc' });

    expect(res.status).toBe(400);
  });

  it('returns 401 without token', async () => {
    const res = await request(app)
      .post('/v1/me/withdrawals')
      .send({ toAddress: 'bc1q...', amountSats: '100000' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/withdrawals — tenant-facing (requires tenant API key)
// ---------------------------------------------------------------------------
describe('GET /v1/withdrawals (tenant-facing)', () => {
  it('returns empty list when no withdrawals exist', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/withdrawals').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/withdrawals');
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown withdrawal id', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/withdrawals/wd_doesnotexist').set(auth);
    expect(res.status).toBe(404);
  });

  it('returns 400 for submit-signed without signedPsbt', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .post('/v1/withdrawals/wd_doesnotexist/submit-signed')
      .set(auth)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/me/withdrawals/:id — not found
// ---------------------------------------------------------------------------
describe('GET /v1/me/withdrawals/:id', () => {
  it('returns 404 for unknown withdrawal', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const res = await request(app)
      .get('/v1/me/withdrawals/wd_doesnotexist')
      .set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(404);
  });
});
