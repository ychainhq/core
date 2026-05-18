/**
 * Integration tests for POST /admin/v1/tenants and tenant provisioning.
 *
 * Covers:
 * - basic tenant creation (hotAddress required)
 * - tenant creation with BTC assets (hotAddress, coldAddress)
 * - LWallet auto-provisioning: customer_deposits always created; tenant_hot / tenant_cold when addresses provided
 * - address validation: invalid Bitcoin addresses rejected before any DB writes
 * - PATCH /admin/v1/tenants/:id/config — hot/cold address update via upsertTreasuryWallet
 * - admin key auth guard
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, AUTH, teardownDb, ADDR_1, ADDR_2, ADDR_3, ADDR_P2SH, uniqueAddr } from './helpers';

// ADDR_3 is used in the "registers hotAddress" test to verify exact address value.
// ADDR_P2SH is used as coldAddress when a test needs a specific known cold address.
// All other tests use uniqueAddr() to avoid UNIQUE(chain_id, address) conflicts.

const app = bootstrapApp();

afterAll(() => teardownDb());

// ---------------------------------------------------------------------------
// POST /admin/v1/tenants — basic creation
// ---------------------------------------------------------------------------
describe('POST /admin/v1/tenants — basic', () => {
  it('creates a tenant with name and hotAddress', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Acme Fintech', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toMatch(/^tenant_/);
    expect(res.body.data.name).toBe('Acme Fintech');
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.config).toBeDefined();
    expect(res.body.data.config.custody_mode).toBe('external_signer');
  });

  it('creates a tenant with metadata', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Meta Tenant', metadata: { region: 'eu', tier: 'pro' }, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });

    expect(res.status).toBe(201);
    expect(res.body.data.metadata).toEqual({ region: 'eu', tier: 'pro' });
  });

  it('returns 400 when assets is missing (hotAddress required)', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'No Assets Tenant' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when assets array is empty', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Empty Assets Tenant', assets: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for missing name', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 without admin key', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .send({ name: 'Unauthorized Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });

    expect(res.status).toBe(401);
  });

  it('returns 401 with tenant API key instead of admin key', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(AUTH)
      .send({ name: 'Wrong Auth Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/v1/tenants — with BTC assets (LWallet provisioning)
// ---------------------------------------------------------------------------
describe('POST /admin/v1/tenants — BTC assets provisioning', () => {
  it('provisions customer_deposits + tenant_hot + tenant_cold LWallets with full BTC assets', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'Full BTC Tenant',
        assets: [
          { chain: 'bitcoin', hotAddress: ADDR_1, coldAddress: ADDR_2 },
        ],
      });

    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    // Generate API key for this tenant so we can query its wallets
    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'test-key' });
    expect(keyRes.status).toBe(201);
    const tenantAuth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    // Fetch all wallets for this tenant
    const walletsRes = await request(app).get('/v1/wallets').set(tenantAuth);
    expect(walletsRes.status).toBe(200);

    const wallets: any[] = walletsRes.body.data;
    const roles = wallets.map((w: any) => w.wallet_role);

    expect(roles).toContain('customer_deposits');
    expect(roles).toContain('tenant_hot');
    expect(roles).toContain('tenant_cold');

    // Verify wallet types
    const hot  = wallets.find((w: any) => w.wallet_role === 'tenant_hot');
    const cold = wallets.find((w: any) => w.wallet_role === 'tenant_cold');
    const deposits = wallets.find((w: any) => w.wallet_role === 'customer_deposits');

    expect(hot.type).toBe('external_signer');
    expect(cold.type).toBe('external_signer');
    expect(deposits.type).toBe('watch_only');
  });

  it('registers hotAddress in the tenant_hot LWallet addresses', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'Hot Addr Tenant',
        assets: [{ chain: 'bitcoin', hotAddress: ADDR_3 }],  // ADDR_3 unique in this file
      });

    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'test-key' });
    const tenantAuth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    const walletsRes = await request(app).get('/v1/wallets').set(tenantAuth);
    const hot = walletsRes.body.data.find((w: any) => w.wallet_role === 'tenant_hot');
    expect(hot).toBeDefined();

    const addrsRes = await request(app)
      .get(`/v1/wallets/${hot.id}/addresses`)
      .set(tenantAuth);

    expect(addrsRes.status).toBe(200);
    expect(addrsRes.body.data.length).toBe(1);
    expect(addrsRes.body.data[0].address).toBe(ADDR_3);
    expect(addrsRes.body.data[0].address_role).toBe('treasury_hot');
  });

  it('creates only customer_deposits + tenant_hot when only hotAddress is provided', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'Hot Only Tenant',
        assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }],
      });

    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'test-key' });
    const tenantAuth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    const walletsRes = await request(app).get('/v1/wallets').set(tenantAuth);
    const roles = walletsRes.body.data.map((w: any) => w.wallet_role);

    expect(roles).toContain('customer_deposits');
    expect(roles).toContain('tenant_hot');
    expect(roles).not.toContain('tenant_cold');
  });

  it('provisions tenant_hot and tenant_cold when both addresses given', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'Hot+Cold Tenant',
        assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr(), coldAddress: ADDR_P2SH }],
      });

    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'test-key' });
    const tenantAuth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    const walletsRes = await request(app).get('/v1/wallets').set(tenantAuth);
    const roles = walletsRes.body.data.map((w: any) => w.wallet_role);

    expect(roles).toContain('customer_deposits');
    expect(roles).toContain('tenant_hot');
    expect(roles).toContain('tenant_cold');
  });
});

// ---------------------------------------------------------------------------
// Address validation in assets
// ---------------------------------------------------------------------------
describe('POST /admin/v1/tenants — address validation', () => {
  it('returns 400 when hotAddress is missing from assets element', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'No Hot Addr Tenant',
        assets: [{ chain: 'bitcoin', coldAddress: ADDR_P2SH }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid bitcoin hotAddress', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'Bad Hot Addr',
        assets: [{ chain: 'bitcoin', hotAddress: 'not-a-bitcoin-address' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid bitcoin coldAddress', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'Bad Cold Addr',
        // hotAddress is valid; coldAddress is invalid — provisionBtcLWallets upfront check fires
        assets: [{ chain: 'bitcoin', hotAddress: ADDR_1, coldAddress: 'definitely-not-valid' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for empty hotAddress string', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'Empty Hot Addr',
        assets: [{ chain: 'bitcoin', hotAddress: '' }],
      });

    // Zod min(1) catches this
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET / PATCH / config / api-keys — other admin tenant endpoints
// ---------------------------------------------------------------------------
describe('GET /admin/v1/tenants', () => {
  it('lists tenants with pagination', async () => {
    const res = await request(app).get('/admin/v1/tenants').set(ADMIN_AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.limit).toBeDefined();
  });

  it('filters by status', async () => {
    const res = await request(app)
      .get('/admin/v1/tenants?status=active')
      .set(ADMIN_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.every((t: any) => t.status === 'active')).toBe(true);
  });
});

describe('GET /admin/v1/tenants/:tenantId', () => {
  it('returns tenant by id', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Lookup Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    const id = createRes.body.data.id;

    const res = await request(app).get(`/admin/v1/tenants/${id}`).set(ADMIN_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });

  it('returns 404 for unknown tenant', async () => {
    const res = await request(app)
      .get('/admin/v1/tenants/tenant_doesnotexist')
      .set(ADMIN_AUTH);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /admin/v1/tenants/:tenantId', () => {
  it('updates tenant name and status', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Before Update', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    const id = createRes.body.data.id;

    const res = await request(app)
      .patch(`/admin/v1/tenants/${id}`)
      .set(ADMIN_AUTH)
      .send({ name: 'After Update', status: 'suspended' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('After Update');
    expect(res.body.data.status).toBe('suspended');
  });
});

describe('PATCH /admin/v1/tenants/:tenantId/config', () => {
  it('updates BTC confirmation thresholds', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Config Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    const id = createRes.body.data.id;

    const res = await request(app)
      .patch(`/admin/v1/tenants/${id}/config`)
      .set(ADMIN_AUTH)
      .send({ btcConfirmationsRequired: 3, btcFinalityConfirmations: 12 });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_confirmations_required).toBe(3);
    expect(res.body.data.btc_finality_confirmations).toBe(12);
  });

  it('updates customerSessionTtlSeconds', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'TTL Config Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    const id = createRes.body.data.id;

    const res = await request(app)
      .patch(`/admin/v1/tenants/${id}/config`)
      .set(ADMIN_AUTH)
      .send({ customerSessionTtlSeconds: 7200 });

    expect(res.status).toBe(200);
    expect(res.body.data.customer_session_ttl_seconds).toBe(7200);
  });

  it('rejects customerSessionTtlSeconds below 60', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'TTL Validation Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    const id = createRes.body.data.id;

    const res = await request(app)
      .patch(`/admin/v1/tenants/${id}/config`)
      .set(ADMIN_AUTH)
      .send({ customerSessionTtlSeconds: 30 });

    expect(res.status).toBe(400);
  });
});

describe('POST /admin/v1/tenants/:tenantId/api-keys', () => {
  it('generates an API key for the tenant', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Key Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    const id = createRes.body.data.id;

    const res = await request(app)
      .post(`/admin/v1/tenants/${id}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'primary-key' });

    expect(res.status).toBe(201);
    expect(res.body.data.apiKey).toMatch(/^cak_/);
    expect(res.body.data.tenantId).toBe(id);
    expect(res.body.data.warning).toBeDefined();
  });

  it('returns 404 when tenant does not exist', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants/tenant_ghost/api-keys')
      .set(ADMIN_AUTH)
      .send({ name: 'key' });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/v1/tenants/:tenantId/config — treasury address update
// ---------------------------------------------------------------------------
describe('PATCH /admin/v1/tenants/:tenantId/config — treasury addresses', () => {
  it('sets btcHotAddress and creates tenant_hot wallet', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Addr Config Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const newHot = uniqueAddr();
    const res = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcHotAddress: newHot });

    expect(res.status).toBe(200);

    // Verify new address is registered in tenant_hot wallet
    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'test-key' });
    const tenantAuth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    const walletsRes = await request(app).get('/v1/wallets').set(tenantAuth);
    const hot = walletsRes.body.data.find((w: any) => w.wallet_role === 'tenant_hot');
    expect(hot).toBeDefined();

    const addrsRes = await request(app).get(`/v1/wallets/${hot.id}/addresses`).set(tenantAuth);
    const active = addrsRes.body.data.filter((a: any) => a.status === 'active');
    expect(active.length).toBe(1);
    expect(active[0].address).toBe(newHot);
  });

  it('sets btcColdAddress and creates tenant_cold wallet', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Cold Config Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const res = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcColdAddress: uniqueAddr() });

    expect(res.status).toBe(200);

    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'test-key' });
    const tenantAuth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    const walletsRes = await request(app).get('/v1/wallets').set(tenantAuth);
    const roles = walletsRes.body.data.map((w: any) => w.wallet_role);
    expect(roles).toContain('tenant_cold');
  });

  it('returns 400 for invalid btcHotAddress', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Addr Validation Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    const tenantId = createRes.body.data.id;

    const res = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcHotAddress: 'not-a-valid-btc-address' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('supersedes old hot address when btcHotAddress is updated', async () => {
    const firstHot = uniqueAddr();
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Hot Rotate Tenant', assets: [{ chain: 'bitcoin', hotAddress: firstHot }] });
    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'test-key' });
    const tenantAuth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    const secondHot = uniqueAddr();
    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcHotAddress: secondHot });

    const walletsRes = await request(app).get('/v1/wallets').set(tenantAuth);
    const hot = walletsRes.body.data.find((w: any) => w.wallet_role === 'tenant_hot');

    const addrsRes = await request(app).get(`/v1/wallets/${hot.id}/addresses`).set(tenantAuth);
    const allAddrs = addrsRes.body.data;
    const active = allAddrs.filter((a: any) => a.status === 'active');
    const replaced = allAddrs.filter((a: any) => a.status === 'replaced');

    expect(active.length).toBe(1);
    expect(active[0].address).toBe(secondHot);
    expect(replaced.length).toBe(1);
    expect(replaced[0].address).toBe(firstHot);
  });
});

// ---------------------------------------------------------------------------
// Helper — not exported; used only inside this file
// ---------------------------------------------------------------------------
async function apiKeyForTenant(tenantId: string): Promise<string> {
  const res = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'internal-test-key' });
  return `Bearer ${res.body.data.apiKey}`;
}
