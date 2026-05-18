/**
 * Tenant isolation tests.
 * Verifies that resources created under tenant A are not visible to tenant B.
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr } from './helpers';
import { getDb } from '../../src/db/sqlite';
import crypto from 'crypto';

const app = bootstrapApp();

afterAll(() => teardownDb());

function sha256(s: string): string {
  return require('crypto').createHash('sha256').update(s).digest('hex');
}

/**
 * Creates a second tenant with its own API key directly in the DB
 * (bypasses admin routes to keep tests self-contained).
 */
function createTestTenant(tenantId: string, apiKey: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO tenants (id, name, status, metadata, created_at, updated_at)
    VALUES (?, ?, 'active', '{}', ?, ?)`).run(tenantId, `Test tenant ${tenantId}`, now, now);
  db.prepare(`INSERT OR IGNORE INTO tenant_configs
    (tenant_id, btc_confirmations_required, btc_finality_confirmations, custody_mode, withdrawal_mode, daily_withdrawal_limit_sats, per_tx_limit_sats, updated_at)
    VALUES (?, 1, 6, 'external_signer', 'external_signer', NULL, NULL, ?)`).run(tenantId, now);
  const keyId = `apikey_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`INSERT OR IGNORE INTO api_keys (id, tenant_id, key_hash, name, is_active, last_used_at, created_at, expires_at)
    VALUES (?, ?, ?, 'test', 1, NULL, ?, NULL)`).run(keyId, tenantId, sha256(apiKey), now);
}

describe('Tenant isolation', () => {
  const TENANT_A_KEY = 'isolation_key_tenant_a';
  const TENANT_B_KEY = 'isolation_key_tenant_b';
  const AUTH_A = { Authorization: `Bearer ${TENANT_A_KEY}` };
  const AUTH_B = { Authorization: `Bearer ${TENANT_B_KEY}` };

  beforeAll(() => {
    createTestTenant('tenant_iso_a', TENANT_A_KEY);
    createTestTenant('tenant_iso_b', TENANT_B_KEY);
  });

  describe('Customers', () => {
    let customerAId: string;

    it('tenant A can create a customer', async () => {
      const res = await request(app)
        .post('/v1/customers')
        .set(AUTH_A)
        .send({ reference: 'cust-from-a' });
      expect(res.status).toBe(201);
      customerAId = res.body.data.id;
    });

    it('tenant B does not see tenant A customers in list', async () => {
      const res = await request(app).get('/v1/customers').set(AUTH_B);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((c: any) => c.id);
      expect(ids).not.toContain(customerAId);
    });

    it('tenant B cannot fetch tenant A customer by id', async () => {
      const res = await request(app)
        .get(`/v1/customers/${customerAId}`)
        .set(AUTH_B);
      expect(res.status).toBe(404);
    });
  });

  describe('Wallets', () => {
    let walletAId: string;

    it('tenant A can create a wallet', async () => {
      const res = await request(app)
        .post('/v1/wallets')
        .set(AUTH_A)
        .send({ name: 'wallet-a', type: 'watch_only' });
      expect(res.status).toBe(201);
      walletAId = res.body.data.id;
    });

    it('tenant B does not see tenant A wallets', async () => {
      const res = await request(app).get('/v1/wallets').set(AUTH_B);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((w: any) => w.id);
      expect(ids).not.toContain(walletAId);
    });

    it('tenant B cannot fetch tenant A wallet by id', async () => {
      const res = await request(app)
        .get(`/v1/wallets/${walletAId}`)
        .set(AUTH_B);
      expect(res.status).toBe(404);
    });
  });

  describe('Admin routes', () => {
    it('requires X-Admin-Key header', async () => {
      const res = await request(app).get('/admin/v1/tenants');
      expect(res.status).toBe(401);
    });

    it('returns tenants list with valid admin key', async () => {
      const res = await request(app)
        .get('/admin/v1/tenants')
        .set(ADMIN_AUTH);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('creates a tenant via admin API', async () => {
      const res = await request(app)
        .post('/admin/v1/tenants')
        .set(ADMIN_AUTH)
        .send({ name: 'New Test Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toMatch(/^tenant_/);
      expect(res.body.data.name).toBe('New Test Tenant');
      expect(res.body.data.status).toBe('active');
    });

    it('generates API key for tenant via admin API', async () => {
      // First create a tenant
      const createRes = await request(app)
        .post('/admin/v1/tenants')
        .set(ADMIN_AUTH)
        .send({ name: 'Key Test Tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
      const tenantId = createRes.body.data.id;

      const keyRes = await request(app)
        .post(`/admin/v1/tenants/${tenantId}/api-keys`)
        .set(ADMIN_AUTH)
        .send({ name: 'test-key' });
      expect(keyRes.status).toBe(201);
      expect(keyRes.body.data.apiKey).toMatch(/^cak_/);
      expect(keyRes.body.data.tenantId).toBe(tenantId);
      expect(keyRes.body.data.warning).toBeDefined();
    });
  });
});
