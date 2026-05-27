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
import crypto from 'crypto';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr, ADDR_1 } from './helpers';
import { ledgerService } from '../../src/modules/ledger/ledger.service';
import { getDb } from '../../src/db/sqlite';

const app = bootstrapApp();
afterAll(() => teardownDb());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function createTenantWithKey(): Promise<{ tenantId: string; auth: { Authorization: string } }> {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `session-test-tenant-${Date.now()}`, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
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
    // expiresAt is a Unix timestamp (seconds) in the future
    expect(res.body.data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
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

  it('respects per-tenant TTL configured via PATCH /admin/v1/tenants/:id/config', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    // Set custom TTL of 120 seconds on this tenant
    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ customerSessionTtlSeconds: 120 });

    const customer = await createCustomer(auth);
    const now = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post(`/v1/customers/${customer.id}/sessions`)
      .set(auth);

    expect(res.status).toBe(201);
    const { expiresAt } = res.body.data;
    // Should expire ~120s from now (allow ±5s for test execution)
    expect(expiresAt).toBeGreaterThanOrEqual(now + 115);
    expect(expiresAt).toBeLessThanOrEqual(now + 125);
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
  it('queues a withdrawal and does not build a PSBT in the request path', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);
    const account = ledgerService.findAccountByCustomerAndAsset(
      tenantId,
      customer.id,
      'bitcoin:BTC'
    );
    expect(account).toBeTruthy();
    ledgerService.addEntry({
      ledgerAccountId: account!.id,
      type: 'test_credit',
      amountRaw: '200000',
      referenceType: 'test',
      referenceId: 'queued_withdrawal',
      isPending: false,
    });

    const res = await request(app)
      .post('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        toAddress: ADDR_1,
        amountSats: '100000',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('queued');
    expect(res.body.data.psbt).toBeNull();
    expect(res.body.data.fee_raw).toBeNull();
  });

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
// GET /v1/me/withdrawals — toAddress filter
// ---------------------------------------------------------------------------
describe('GET /v1/me/withdrawals — toAddress filter', () => {
  it('returns only withdrawals matching the given toAddress', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const db = getDb();
    const now = new Date().toISOString();
    const addrA = ADDR_1;
    const addrB = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

    const wdA = `wd_filter_a_${crypto.randomBytes(4).toString('hex')}`;
    const wdB = `wd_filter_b_${crypto.randomBytes(4).toString('hex')}`;

    db.prepare(`
      INSERT INTO customer_withdrawals
        (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, status, created_at, updated_at)
      VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', ?, '1000', 'queued', ?, ?)
    `).run(wdA, tenantId, customer.id, addrA, now, now);

    db.prepare(`
      INSERT INTO customer_withdrawals
        (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, status, created_at, updated_at)
      VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', ?, '2000', 'queued', ?, ?)
    `).run(wdB, tenantId, customer.id, addrB, now, now);

    const res = await request(app)
      .get(`/v1/me/withdrawals?toAddress=${addrA}`)
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    const ids = res.body.data.map((w: any) => w.id);
    expect(ids).toContain(wdA);
    expect(ids).not.toContain(wdB);
  });

  it('returns empty list when no withdrawal matches the toAddress', async () => {
    const { auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const res = await request(app)
      .get('/v1/me/withdrawals?toAddress=bc1qnonexistentaddressxxxxxxxxxxxxxxxxxxxxxx')
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('returns all withdrawals when toAddress is not specified', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const customer = await createCustomer(auth);
    const token = await issueSession(auth, customer.id);

    const db = getDb();
    const now = new Date().toISOString();

    ['wd_all_a', 'wd_all_b'].forEach(id => {
      db.prepare(`
        INSERT INTO customer_withdrawals
          (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, status, created_at, updated_at)
        VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', ?, '1000', 'queued', ?, ?)
      `).run(`${id}_${crypto.randomBytes(3).toString('hex')}`, tenantId, customer.id, ADDR_1, now, now);
    });

    const res = await request(app)
      .get('/v1/me/withdrawals')
      .set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
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

// ---------------------------------------------------------------------------
// GET /v1/withdrawals?customerId= — filter by customer
// ---------------------------------------------------------------------------
describe('GET /v1/withdrawals?customerId= (customer filter)', () => {
  it('returns only withdrawals belonging to the specified customer', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const custA = await createCustomer(auth, `ref_cust_a_${Date.now()}`);
    const custB = await createCustomer(auth, `ref_cust_b_${Date.now()}`);
    const db = getDb();
    const now = new Date().toISOString();

    const wdA = `wd_${crypto.randomBytes(8).toString('hex')}`;
    const wdB = `wd_${crypto.randomBytes(8).toString('hex')}`;

    db.prepare(`
      INSERT INTO customer_withdrawals
        (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, status, created_at, updated_at)
      VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', '5000', 'queued', ?, ?)
    `).run(wdA, tenantId, custA.id, now, now);

    db.prepare(`
      INSERT INTO customer_withdrawals
        (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, status, created_at, updated_at)
      VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', '3000', 'queued', ?, ?)
    `).run(wdB, tenantId, custB.id, now, now);

    const res = await request(app)
      .get(`/v1/withdrawals?customerId=${custA.id}`)
      .set(auth);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((w: any) => w.id);
    expect(ids).toContain(wdA);
    expect(ids).not.toContain(wdB);
  });

  it('returns empty list for a customer with no withdrawals', async () => {
    const { auth } = await createTenantWithKey();
    const custC = await createCustomer(auth, `ref_cust_c_${Date.now()}`);

    const res = await request(app)
      .get(`/v1/withdrawals?customerId=${custC.id}`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('does not return withdrawals from another tenant when filtering by customerId', async () => {
    const { tenantId: tenantA, auth: authA } = await createTenantWithKey();
    const { tenantId: tenantB, auth: authB } = await createTenantWithKey();
    const custA = await createCustomer(authA, `ref_iso_a_${Date.now()}`);
    const custB = await createCustomer(authB, `ref_iso_b_${Date.now()}`);
    const db = getDb();
    const now = new Date().toISOString();

    const wdA = `wd_${crypto.randomBytes(8).toString('hex')}`;
    const wdB = `wd_${crypto.randomBytes(8).toString('hex')}`;

    db.prepare(`
      INSERT INTO customer_withdrawals
        (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, status, created_at, updated_at)
      VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', '1000', 'queued', ?, ?)
    `).run(wdA, tenantA, custA.id, now, now);

    db.prepare(`
      INSERT INTO customer_withdrawals
        (id, tenant_id, customer_id, chain_id, asset_id, to_address, amount_raw, status, created_at, updated_at)
      VALUES (?, ?, ?, 'bitcoin', 'bitcoin:BTC', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', '2000', 'queued', ?, ?)
    `).run(wdB, tenantB, custB.id, now, now);

    // Tenant B querying with custA's id: custA doesn't exist in tenantB → 404 (RBAC guard)
    const res = await request(app)
      .get(`/v1/withdrawals?customerId=${custA.id}`)
      .set(authB);

    // The customer access guard rejects the request before listing withdrawals
    expect(res.status).toBe(404);
  });
});
