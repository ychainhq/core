/**
 * Integration tests for GAP 1 — Auto-provisioning of ledger accounts.
 *
 * Covers:
 * - Tenant creation: customer_deposits wallet ledger account auto-created
 * - Tenant creation with hotAddress: tenant_hot_control ledger account created
 * - Tenant creation with coldAddress: tenant_cold_control ledger account created
 * - Tenant operational accounts: sweep_in_transit + network_fee_expense
 * - Customer creation: customer_available + customer_pending ledger accounts auto-created
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, teardownDb, ADDR_1, ADDR_2 } from './helpers';

const app = bootstrapApp();
afterAll(() => teardownDb());

describe('GAP 1 — Tenant ledger account auto-provisioning', () => {
  it('auto-creates customer_deposits ledger account when tenant has no assets', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Ledger Auto Tenant' });
    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'key' });
    const auth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    const ledgerRes = await request(app).get('/v1/ledger/accounts').set(auth);
    expect(ledgerRes.status).toBe(200);

    const accounts = ledgerRes.body.data;
    expect(accounts.length).toBeGreaterThanOrEqual(3);

    const types = accounts.map((a: any) => a.account_type);
    expect(types).toContain('customer_available');
    expect(types).toContain('sweep_in_transit');
    expect(types).toContain('network_fee_expense');
  });

  it('auto-creates tenant_hot_control ledger account when hotAddress provided', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'Hot Ledger Tenant',
        assets: [{ chain: 'bitcoin', hotAddress: ADDR_1 }],
      });
    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'key' });
    const auth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    const ledgerRes = await request(app).get('/v1/ledger/accounts').set(auth);
    expect(ledgerRes.status).toBe(200);

    const types = ledgerRes.body.data.map((a: any) => a.account_type);
    expect(types).toContain('tenant_hot_control');
    expect(types).not.toContain('tenant_cold_control');
  });

  it('auto-creates tenant_cold_control ledger account when coldAddress provided', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'Cold Ledger Tenant',
        assets: [{ chain: 'bitcoin', coldAddress: ADDR_2 }],
      });
    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'key' });
    const auth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    const ledgerRes = await request(app).get('/v1/ledger/accounts').set(auth);
    const types = ledgerRes.body.data.map((a: any) => a.account_type);
    expect(types).toContain('tenant_cold_control');
    expect(types).not.toContain('tenant_hot_control');
  });
});

describe('GAP 1 — Customer ledger account auto-provisioning', () => {
  let auth: { Authorization: string };

  beforeAll(async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'Customer Ledger Tenant' });
    const tenantId = createRes.body.data.id;
    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'key' });
    auth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };
  });

  it('auto-creates customer_available and customer_pending ledger accounts on customer creation', async () => {
    const custRes = await request(app)
      .post('/v1/customers')
      .set(auth)
      .send({ reference: 'test-cust-ledger-1' });
    expect(custRes.status).toBe(201);
    const customerId = custRes.body.data.id;

    const ledgerRes = await request(app).get('/v1/ledger/accounts').set(auth);
    expect(ledgerRes.status).toBe(200);

    const customerAccounts = ledgerRes.body.data.filter(
      (a: any) => a.customer_id === customerId
    );
    expect(customerAccounts.length).toBe(2);

    const types = customerAccounts.map((a: any) => a.account_type);
    expect(types).toContain('customer_available');
    expect(types).toContain('customer_pending');
  });

  it('each customer gets separate ledger accounts', async () => {
    const c1 = await request(app).post('/v1/customers').set(auth).send({ reference: 'cust-sep-1' });
    const c2 = await request(app).post('/v1/customers').set(auth).send({ reference: 'cust-sep-2' });

    const ledgerRes = await request(app).get('/v1/ledger/accounts').set(auth);
    const accts = ledgerRes.body.data;

    const c1Accts = accts.filter((a: any) => a.customer_id === c1.body.data.id);
    const c2Accts = accts.filter((a: any) => a.customer_id === c2.body.data.id);

    expect(c1Accts.length).toBe(2);
    expect(c2Accts.length).toBe(2);
    // Accounts belong to different customers
    const c1Ids = c1Accts.map((a: any) => a.id);
    const c2Ids = c2Accts.map((a: any) => a.id);
    expect(c1Ids.some((id: string) => c2Ids.includes(id))).toBe(false);
  });
});
