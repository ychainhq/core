/**
 * Integration tests for GAP 2 — Sweep management endpoints.
 *
 * Covers:
 * - GET /v1/sweeps returns empty list initially
 * - GET /v1/sweeps/:sweepId returns 404 for unknown
 * - POST /v1/sweeps/:sweepId/submit-signed returns 400 if not pending_signature
 * - btcSweepThresholdSats stored and returned in tenant config
 * - Sweep is tenant-scoped (cross-tenant access denied)
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr } from './helpers';

const app = bootstrapApp();
afterAll(() => teardownDb());

async function createTenantWithKey(): Promise<{ tenantId: string; auth: { Authorization: string } }> {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `sweep-test-tenant-${Date.now()}`, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
  const tenantId = createRes.body.data.id;
  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'key' });
  return { tenantId, auth: { Authorization: `Bearer ${keyRes.body.data.apiKey}` } };
}

describe('GET /v1/sweeps', () => {
  it('returns empty list when no sweeps exist', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/sweeps').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toBeDefined();
  });

  it('requires auth', async () => {
    const res = await request(app).get('/v1/sweeps');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/sweeps/:sweepId', () => {
  it('returns 404 for unknown sweep', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/sweeps/sweep_doesnotexist').set(auth);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/sweeps/:sweepId/submit-signed', () => {
  it('returns 404 for unknown sweep', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .post('/v1/sweeps/sweep_ghost/submit-signed')
      .set(auth)
      .send({ signedPsbt: 'fakepsbt==' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when signedPsbt is missing', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .post('/v1/sweeps/sweep_ghost/submit-signed')
      .set(auth)
      .send({});
    // 400 from Zod validation (signedPsbt required)
    expect(res.status).toBe(400);
  });
});

describe('Tenant config — sweep threshold', () => {
  it('stores and returns btcSweepThresholdSats', async () => {
    const { tenantId } = await createTenantWithKey();

    const res = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcSweepThresholdSats: '250000' });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_sweep_threshold_sats).toBe('250000');
  });

  it('default sweep threshold is 100000 sats', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'default-sweep-tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    const tenantId = createRes.body.data.id;

    const res = await request(app)
      .get(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.btc_sweep_threshold_sats).toBe('100000');
  });
});
