/**
 * Integration tests for /v1/tenant — tenant self-service API.
 *
 * Covers:
 * - GET /v1/tenant — own profile + config
 * - PATCH /v1/tenant — name + metadata only
 * - GET /v1/tenant/config — config read
 * - PATCH /v1/tenant/config — safe fields only
 *
 * Security cases:
 * - No auth → 401
 * - Customer session token → 401 (wrong auth type)
 * - Admin key as Bearer → 401 (admin keys not in api_keys table)
 * - PATCH /v1/tenant with status in body → status NOT changed (stripped by schema)
 * - PATCH /v1/tenant/config with custodyMode → custodyMode NOT changed (stripped)
 * - PATCH /v1/tenant/config with btcNextDerivationIndex → NOT changed (stripped)
 * - Tenant A key returns only tenant A data; tenant B key returns only tenant B data
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr } from './helpers';

const app = bootstrapApp();
afterAll(() => teardownDb());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTenantWithKey(): Promise<{
  tenantId: string;
  auth: { Authorization: string };
  initialCustodyMode: string;
}> {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `self-svc-tenant-${Date.now()}`, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
  expect(createRes.status).toBe(201);
  const tenantId = createRes.body.data.id;
  const initialCustodyMode = createRes.body.data.config?.custody_mode ?? 'external_signer';

  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'self-svc-key' });
  expect(keyRes.status).toBe(201);

  return {
    tenantId,
    auth: { Authorization: `Bearer ${keyRes.body.data.apiKey}` },
    initialCustodyMode,
  };
}

async function getCustomerToken(auth: Record<string, string>): Promise<string> {
  const custRes = await request(app)
    .post('/v1/customers')
    .set(auth)
    .send({ reference: `sec-test-${Date.now()}` });
  expect(custRes.status).toBe(201);

  const sessRes = await request(app)
    .post(`/v1/customers/${custRes.body.data.id}/sessions`)
    .set(auth);
  expect(sessRes.status).toBe(201);
  return sessRes.body.data.accessToken;
}

// ---------------------------------------------------------------------------
// GET /v1/tenant
// ---------------------------------------------------------------------------

describe('GET /v1/tenant', () => {
  it('returns own tenant profile and config', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/tenant').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(tenantId);
    expect(res.body.data.name).toBeDefined();
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.config).toBeDefined();
    expect(res.body.data.config.custody_mode).toBeDefined();
    expect(typeof res.body.data.created_at).toBe('number');
    expect(typeof res.body.data.updated_at).toBe('number');
  });

  it('returns 401 without Authorization header', async () => {
    const res = await request(app).get('/v1/tenant');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a customer session token', async () => {
    const { auth } = await createTenantWithKey();
    const customerToken = await getCustomerToken(auth);

    const res = await request(app)
      .get('/v1/tenant')
      .set({ Authorization: `Bearer ${customerToken}` });
    expect(res.status).toBe(401);
  });

  it('returns 401 with an admin key used as Bearer', async () => {
    const res = await request(app)
      .get('/v1/tenant')
      .set({ Authorization: 'Bearer test_admin_key_integration_secret' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/tenant — profile update
// ---------------------------------------------------------------------------

describe('PATCH /v1/tenant', () => {
  it('updates name', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant')
      .set(auth)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated Name');
  });

  it('updates metadata', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant')
      .set(auth)
      .send({ metadata: { contractId: 'c-999', env: 'staging' } });

    expect(res.status).toBe(200);
    expect(res.body.data.metadata).toEqual({ contractId: 'c-999', env: 'staging' });
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).patch('/v1/tenant').send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  // ── Security: status is admin-only ────────────────────────────────────────

  it('SECURITY: status field in body is silently stripped — status stays active', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant')
      .set(auth)
      .send({ name: 'Renamed', status: 'disabled' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed');
    expect(res.body.data.status).toBe('active'); // NOT changed
  });

  it('SECURITY: body with only status returns 200 but status remains active', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant')
      .set(auth)
      .send({ status: 'suspended' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active'); // NOT changed
  });
});

// ---------------------------------------------------------------------------
// GET /v1/tenant/config
// ---------------------------------------------------------------------------

describe('GET /v1/tenant/config', () => {
  it('returns tenant config', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/tenant/config').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.data.tenant_id).toBe(tenantId);
    expect(res.body.data.custody_mode).toBeDefined();
    expect(res.body.data.btc_confirmations_required).toBeDefined();
    expect(typeof res.body.data.updated_at).toBe('number');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/tenant/config');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/tenant/config — safe fields
// ---------------------------------------------------------------------------

describe('PATCH /v1/tenant/config', () => {
  it('updates btcConfirmationsRequired', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ btcConfirmationsRequired: 3 });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_confirmations_required).toBe(3);
  });

  it('updates btcFinalityConfirmations', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ btcFinalityConfirmations: 12 });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_finality_confirmations).toBe(12);
  });

  it('updates withdrawalMode', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ withdrawalMode: 'manual_approval' });

    expect(res.status).toBe(200);
    expect(res.body.data.withdrawal_mode).toBe('manual_approval');
  });

  it('updates dailyWithdrawalLimitSats', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ dailyWithdrawalLimitSats: '50000000' });

    expect(res.status).toBe(200);
    expect(res.body.data.daily_withdrawal_limit_sats).toBe('50000000');
  });

  it('updates btcXpub', async () => {
    const { auth } = await createTenantWithKey();
    const tpub = 'tpubDCcbryjRMXihfXttvzrqmGKGomV8o1jEQKrytGk5LGDLGJUuWTwNSH6Y3rVhZMSuv3KFKe5o21nB3GYyMC25TXPRxU757xpeFn4voY6aLuC';
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ btcXpub: tpub });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_xpub).toBe(tpub);
  });

  it('clears btcXpub when set to null', async () => {
    const { auth } = await createTenantWithKey();
    await request(app).patch('/v1/tenant/config').set(auth)
      .send({ btcXpub: 'tpubDCcbryjRMXihfXttvzrqmGKGomV8o1jEQKrytGk5LGDLGJUuWTwNSH6Y3rVhZMSuv3KFKe5o21nB3GYyMC25TXPRxU757xpeFn4voY6aLuC' });

    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ btcXpub: null });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_xpub).toBeNull();
  });

  it('updates customerSessionTtlSeconds', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ customerSessionTtlSeconds: 7200 });

    expect(res.status).toBe(200);
    expect(res.body.data.customer_session_ttl_seconds).toBe(7200);
  });

  it('rejects customerSessionTtlSeconds below 60', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ customerSessionTtlSeconds: 30 });

    expect(res.status).toBe(400);
  });

  it('rejects invalid withdrawalMode', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ withdrawalMode: 'delete_everything' });

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).patch('/v1/tenant/config').send({ btcConfirmationsRequired: 1 });
    expect(res.status).toBe(401);
  });

  // ── Security: admin-only fields ───────────────────────────────────────────

  it('SECURITY: custodyMode in body is silently stripped — custody_mode unchanged', async () => {
    const { auth, initialCustodyMode } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ custodyMode: 'platform_custody', btcConfirmationsRequired: 2 });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_confirmations_required).toBe(2);       // safe field updated
    expect(res.body.data.custody_mode).toBe(initialCustodyMode);    // NOT changed
  });

  it('SECURITY: btcNextDerivationIndex in body is silently stripped — index unchanged', async () => {
    const { auth } = await createTenantWithKey();
    const beforeRes = await request(app).get('/v1/tenant/config').set(auth);
    const indexBefore = beforeRes.body.data.btc_next_derivation_index;

    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ btcNextDerivationIndex: 9999 });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_next_derivation_index).toBe(indexBefore); // NOT changed
  });

  it('SECURITY: body with only custodyMode returns 200 but custody_mode unchanged', async () => {
    const { auth, initialCustodyMode } = await createTenantWithKey();
    const res = await request(app)
      .patch('/v1/tenant/config')
      .set(auth)
      .send({ custodyMode: 'hybrid_custody' });

    expect(res.status).toBe(200);
    expect(res.body.data.custody_mode).toBe(initialCustodyMode); // NOT changed
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — the critical security guarantee
// ---------------------------------------------------------------------------

describe('Security — tenant isolation', () => {
  it('each tenant sees only their own data — different API keys return different tenant profiles', async () => {
    const { tenantId: tidA, auth: authA } = await createTenantWithKey();
    const { tenantId: tidB, auth: authB } = await createTenantWithKey();

    const resA = await request(app).get('/v1/tenant').set(authA);
    const resB = await request(app).get('/v1/tenant').set(authB);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.data.id).toBe(tidA);
    expect(resB.body.data.id).toBe(tidB);
    expect(resA.body.data.id).not.toBe(resB.body.data.id);
  });

  it('PATCH /v1/tenant/config by tenant A does not affect tenant B config', async () => {
    const { auth: authA } = await createTenantWithKey();
    const { auth: authB } = await createTenantWithKey();

    const beforeB = await request(app).get('/v1/tenant/config').set(authB);
    const confirmsBefore = beforeB.body.data.btc_confirmations_required;

    await request(app)
      .patch('/v1/tenant/config')
      .set(authA)
      .send({ btcConfirmationsRequired: 5 });

    const afterB = await request(app).get('/v1/tenant/config').set(authB);
    expect(afterB.body.data.btc_confirmations_required).toBe(confirmsBefore); // unchanged
  });

  it('PATCH /v1/tenant by tenant A does not affect tenant B name', async () => {
    const { auth: authA } = await createTenantWithKey();
    const { auth: authB } = await createTenantWithKey();

    const beforeB = await request(app).get('/v1/tenant').set(authB);
    const nameBefore = beforeB.body.data.name;

    await request(app)
      .patch('/v1/tenant')
      .set(authA)
      .send({ name: 'Tenant A Renamed' });

    const afterB = await request(app).get('/v1/tenant').set(authB);
    expect(afterB.body.data.name).toBe(nameBefore); // unchanged
  });

  it('customer session token is rejected on all /v1/tenant routes', async () => {
    const { auth } = await createTenantWithKey();
    const customerToken = await getCustomerToken(auth);
    const customerAuth = { Authorization: `Bearer ${customerToken}` };

    const [r1, r2, r3, r4] = await Promise.all([
      request(app).get('/v1/tenant').set(customerAuth),
      request(app).patch('/v1/tenant').set(customerAuth).send({ name: 'X' }),
      request(app).get('/v1/tenant/config').set(customerAuth),
      request(app).patch('/v1/tenant/config').set(customerAuth).send({ btcConfirmationsRequired: 1 }),
    ]);

    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(401);
    expect(r4.status).toBe(401);
  });
});
