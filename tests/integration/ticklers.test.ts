import request from 'supertest';
import { bootstrapApp, AUTH, ADMIN_AUTH, TEST_TENANT_ID, teardownDb, uniqueAddr } from './helpers';
import { getDb } from '../../src/db/sqlite';

const app = bootstrapApp();

afterAll(() => teardownDb());

// Helper: count ticklers for tenant matching subcategory
function countTicklers(subcategory: string, tenantId = TEST_TENANT_ID): number {
  const db = getDb();
  return (db.prepare("SELECT COUNT(*) as c FROM ticklers WHERE subcategory = ? AND tenant_id = ?")
    .get(subcategory, tenantId) as any).c;
}

function latestTickler(subcategory: string, tenantId: string | null = TEST_TENANT_ID): any {
  const db = getDb();
  const q = tenantId === null
    ? "SELECT * FROM ticklers WHERE subcategory = ? AND tenant_id IS NULL ORDER BY occurred_at DESC LIMIT 1"
    : "SELECT * FROM ticklers WHERE subcategory = ? AND tenant_id = ? ORDER BY occurred_at DESC LIMIT 1";
  return tenantId === null
    ? db.prepare(q).get(subcategory)
    : db.prepare(q).get(subcategory, tenantId);
}

// ---- REST API tests ----

describe('GET /v1/ticklers', () => {
  beforeAll(async () => {
    // Trigger a create to produce ticklers
    await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Tickler Test Wallet', type: 'watch_only' });
  });

  it('returns 200 with data array', async () => {
    const res = await request(app).get('/v1/ticklers').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
  });

  it('filters by category', async () => {
    const res = await request(app).get('/v1/ticklers?category=wallet').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.every((t: any) => t.category === 'wallet')).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/ticklers');
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/v1/ticklers', () => {
  it('returns 200 with all ticklers', async () => {
    const res = await request(app).get('/admin/v1/ticklers').set(ADMIN_AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('filters by tenantId query param', async () => {
    const res = await request(app)
      .get(`/admin/v1/ticklers?tenantId=${TEST_TENANT_ID}`)
      .set(ADMIN_AUTH);
    expect(res.status).toBe(200);
    // All returned ticklers must match tenantId (or be global if includeGlobal not sent)
    const tenantRows = res.body.data.filter((t: any) => t.tenant_id !== null);
    expect(tenantRows.every((t: any) => t.tenant_id === TEST_TENANT_ID)).toBe(true);
  });

  it('returns 401 without admin key', async () => {
    const res = await request(app).get('/admin/v1/ticklers');
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/v1/tenants/:tenantId/ticklers', () => {
  it('returns 200 with tenant-scoped ticklers', async () => {
    const res = await request(app)
      .get(`/admin/v1/tenants/${TEST_TENANT_ID}/ticklers`)
      .set(ADMIN_AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ---- Coverage tests: mutations produce ticklers ----

describe('Tickler coverage — wallet', () => {
  it('creates a wallet.created tickler', async () => {
    const res = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Coverage Wallet', type: 'watch_only' });
    expect(res.status).toBe(201);
    const walletId = res.body.data.id;

    const t = db_get(
      "SELECT * FROM ticklers WHERE subcategory = 'created' AND category = 'wallet' AND entity_id = ?",
      walletId
    );
    expect(t).toBeTruthy();
    expect(t.category).toBe('wallet');
  });
});

describe('Tickler coverage — payment request', () => {
  let walletId: string;
  let addr: string;

  beforeAll(async () => {
    const wRes = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'PR Test Wallet', type: 'watch_only' });
    walletId = wRes.body.data.id;

    addr = uniqueAddr();
    await request(app)
      .post(`/v1/wallets/${walletId}/addresses`)
      .set(AUTH)
      .send({ address: addr, chain: 'bitcoin' });
  });

  it('creates a payment_request.created tickler on POST /v1/payment-requests', async () => {
    const before = countTicklers('created');
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({ chain: 'bitcoin', asset: 'BTC', amount: '100000', address: addr });
    expect(res.status).toBe(201);
    expect(countTicklers('created')).toBeGreaterThan(before);

    const prId = res.body.data.id;
    const t = latestTickler('created');
    expect(t.category).toBe('payment_request');
    expect(t.entity_id).toBe(prId);

    // Also verify cancel produces a tickler
    const cancelRes = await request(app)
      .post(`/v1/payment-requests/${prId}/cancel`)
      .set(AUTH);
    expect(cancelRes.status).toBe(200);

    const tc = db_get("SELECT * FROM ticklers WHERE subcategory = 'cancelled' AND entity_id = ?", prId);
    expect(tc).toBeTruthy();
    expect(tc.category).toBe('payment_request');
  });
});

describe('Tickler coverage — webhook', () => {
  it('creates a webhook.created tickler', async () => {
    const res = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({ url: 'https://example.com/tck', events: ['deposit.detected'] });
    expect(res.status).toBe(201);

    const t = db_get("SELECT * FROM ticklers WHERE subcategory = 'created' AND entity_id = ?", res.body.data.id);
    expect(t).toBeTruthy();
    expect(t.category).toBe('webhook');
  });

  it('creates a webhook.updated tickler on PATCH', async () => {
    const createRes = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({ url: 'https://example.com/tck2', events: ['deposit.detected'] });
    const wId = createRes.body.data.id;

    await request(app).patch(`/v1/webhooks/${wId}`).set(AUTH).send({ isActive: false });

    const t = db_get("SELECT * FROM ticklers WHERE subcategory = 'updated' AND entity_id = ?", wId);
    expect(t).toBeTruthy();
    expect(JSON.parse(t.prev_value)).toBeDefined();
  });
});

describe('Tickler coverage — customer', () => {
  it('creates a customer.created tickler', async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ externalId: `tck-${Date.now()}`, name: 'Tickler Test Customer' });
    expect(res.status).toBe(201);

    const t = db_get(
      "SELECT * FROM ticklers WHERE subcategory = 'created' AND entity_id = ?",
      res.body.data.id
    );
    expect(t).toBeTruthy();
    expect(t.category).toBe('customer');
  });
});

describe('Tickler coverage — ledger', () => {
  it('creates a ledger.account.created tickler', async () => {
    const wRes = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Ledger Tickler Wallet', type: 'watch_only' });
    const walletId = wRes.body.data.id;

    const res = await request(app)
      .post('/v1/ledger/accounts')
      .set(AUTH)
      .send({ chainId: 'bitcoin', assetId: 'bitcoin:BTC', name: 'Test Account', walletId });
    expect(res.status).toBe(201);

    const t = db_get(
      "SELECT * FROM ticklers WHERE subcategory = 'account.created' AND entity_id = ?",
      res.body.data.id
    );
    expect(t).toBeTruthy();
    expect(t.category).toBe('ledger');
  });
});

describe('Tickler coverage — admin tenant operations', () => {
  it('creates a platform.tenant.created tickler on POST /admin/v1/tenants', async () => {
    const res = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: `Tickler Tenant ${Date.now()}`, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    expect(res.status).toBe(201);

    const t = db_get(
      "SELECT * FROM ticklers WHERE subcategory = 'tenant.created' AND entity_id = ?",
      res.body.data.id
    );
    expect(t).toBeTruthy();
    expect(t.category).toBe('platform');
    expect(t.tenant_id).toBeNull();
  });
});

// Simple helper to avoid repeating getDb()
function db_get(sql: string, ...params: any[]): any {
  return getDb().prepare(sql).get(...params);
}
