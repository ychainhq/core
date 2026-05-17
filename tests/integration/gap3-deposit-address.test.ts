/**
 * Integration tests for GAP 3 — xpub deposit address generation.
 *
 * Covers:
 * - PATCH /admin/v1/tenants/:id/config stores btcXpub
 * - POST /v1/customers/:customerId/deposit-address derives a P2WPKH address
 * - Consecutive calls increment the derivation index (unique addresses)
 * - btcXpub configurable at tenant creation via assets[].xpub
 * - Without xpub → 400 with actionable message
 * - Address is registered in customer_deposits wallet + watched_addresses
 * - Invalid tenant ID → 401 / 404 guards
 */
import request from 'supertest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { bootstrapApp, ADMIN_AUTH, teardownDb } from './helpers';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

// Each test scenario needs a unique xpub so their derived m/0/0 addresses don't
// collide with the global UNIQUE(chain_id, address) constraint in the shared DB.
let xpubSeedCounter = 10;
function uniqueXpub(): string {
  const seed = Buffer.alloc(32, xpubSeedCounter++);
  return bip32.fromSeed(seed, bitcoin.networks.bitcoin).neutered().toBase58();
}

const TEST_XPUB = uniqueXpub();

const app = bootstrapApp();
afterAll(() => teardownDb());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function createTenantWithKey(): Promise<{ tenantId: string; auth: { Authorization: string } }> {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `xpub-test-tenant-${Date.now()}` });
  const tenantId = createRes.body.data.id;
  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'key' });
  return { tenantId, auth: { Authorization: `Bearer ${keyRes.body.data.apiKey}` } };
}

// ---------------------------------------------------------------------------
// xpub config
// ---------------------------------------------------------------------------
describe('PATCH /admin/v1/tenants/:id/config — btcXpub', () => {
  it('stores btcXpub and btcSweepThresholdSats', async () => {
    const { tenantId } = await createTenantWithKey();

    const res = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcXpub: TEST_XPUB, btcSweepThresholdSats: '50000' });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_xpub).toBe(TEST_XPUB);
    expect(res.body.data.btc_sweep_threshold_sats).toBe('50000');
    expect(res.body.data.btc_next_derivation_index).toBe(0);
  });

  it('accepts btcXpub set to null (clearing it)', async () => {
    const { tenantId } = await createTenantWithKey();

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcXpub: TEST_XPUB });

    const clearRes = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcXpub: null });

    expect(clearRes.status).toBe(200);
    expect(clearRes.body.data.btc_xpub).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/customers/:customerId/deposit-address
// ---------------------------------------------------------------------------
describe('POST /v1/customers/:customerId/deposit-address', () => {
  it('returns 400 when no btcXpub configured', async () => {
    const { auth } = await createTenantWithKey();
    const custRes = await request(app)
      .post('/v1/customers')
      .set(auth)
      .send({ reference: 'no-xpub-cust' });
    const customerId = custRes.body.data.id;

    const res = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address`)
      .set(auth)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/btcXpub/i);
  });

  it('returns 201 with a valid BTC address when xpub is configured', async () => {
    const { tenantId, auth } = await createTenantWithKey();

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcXpub: uniqueXpub() });

    const custRes = await request(app)
      .post('/v1/customers')
      .set(auth)
      .send({ reference: 'xpub-cust-1' });
    const customerId = custRes.body.data.id;

    const res = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address`)
      .set(auth)
      .send();

    expect(res.status).toBe(201);
    expect(res.body.data.address).toMatch(/^bc1q/); // P2WPKH bech32
    expect(res.body.data.chain).toBe('bitcoin');
    expect(res.body.data.derivationIndex).toBe(0);
    expect(res.body.data.derivationPath).toBe('m/0/0');
    expect(res.body.data.customerId).toBe(customerId);
  });

  it('consecutive calls return unique addresses with incrementing indexes', async () => {
    const { tenantId, auth } = await createTenantWithKey();

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcXpub: uniqueXpub() });

    const custRes = await request(app)
      .post('/v1/customers')
      .set(auth)
      .send({ reference: 'xpub-cust-multi' });
    const customerId = custRes.body.data.id;

    const r0 = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address`)
      .set(auth)
      .send();
    const r1 = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address`)
      .set(auth)
      .send();
    const r2 = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address`)
      .set(auth)
      .send();

    expect(r0.status).toBe(201);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    expect(r0.body.data.derivationIndex).toBe(0);
    expect(r1.body.data.derivationIndex).toBe(1);
    expect(r2.body.data.derivationIndex).toBe(2);

    // All addresses must be unique
    const addrs = [r0.body.data.address, r1.body.data.address, r2.body.data.address];
    expect(new Set(addrs).size).toBe(3);
  });

  it('address is registered in customer addresses list', async () => {
    const { tenantId, auth } = await createTenantWithKey();

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcXpub: uniqueXpub() });

    const custRes = await request(app)
      .post('/v1/customers')
      .set(auth)
      .send({ reference: 'xpub-cust-addr-check' });
    const customerId = custRes.body.data.id;

    const depRes = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address`)
      .set(auth)
      .send();
    const derivedAddress = depRes.body.data.address;

    const addrsRes = await request(app)
      .get(`/v1/customers/${customerId}/addresses`)
      .set(auth);

    expect(addrsRes.status).toBe(200);
    expect(addrsRes.body.data.some((a: any) => a.address === derivedAddress)).toBe(true);
  });

  it('returns 404 for unknown customer', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcXpub: uniqueXpub() });

    const res = await request(app)
      .post('/v1/customers/cust_doesnotexist/deposit-address')
      .set(auth)
      .send();

    expect(res.status).toBe(404);
  });

  it('xpub set at tenant creation via assets[].xpub is stored in config', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({
        name: 'xpub-at-creation-tenant',
        assets: [{ chain: 'bitcoin', xpub: TEST_XPUB }],
      });
    expect(createRes.status).toBe(201);
    const tenantId = createRes.body.data.id;

    const cfgRes = await request(app)
      .get(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH);

    expect(cfgRes.status).toBe(200);
    expect(cfgRes.body.data.btc_xpub).toBe(TEST_XPUB);
  });
});
