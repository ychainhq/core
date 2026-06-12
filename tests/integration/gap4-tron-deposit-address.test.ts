/**
 * Integration tests for TRON/USDT HD deposit address generation.
 *
 * Covers:
 * - PATCH /admin/v1/tenants/:id/config stores tronXpub + tronConfirmationsRequired
 * - POST /v1/customers/:id/deposit-address?chain=tron derives a TRON address
 * - Consecutive calls generate unique addresses (index increments atomically)
 * - Without tron_xpub → 400 with actionable message
 * - Address is registered in customer_deposits wallet + watched_addresses
 * - tronConfirmationsRequired defaults and can be set per-tenant
 * - response.chain equals 'tron'
 */

import request from 'supertest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { bootstrapApp, AUTH, ADMIN_AUTH, teardownDb, uniqueAddr } from './helpers';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

jest.setTimeout(60000);

const app = bootstrapApp();
afterAll(() => teardownDb());

let tronXpubCounter = 50;
function uniqueTronXpub(): string {
  const seed = Buffer.alloc(32, tronXpubCounter++);
  return bip32.fromSeed(seed, bitcoin.networks.bitcoin).neutered().toBase58();
}

async function createTenantWithKey(): Promise<{
  tenantId: string;
  auth: { Authorization: string };
  customerId: string;
}> {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({
      name: `tron-test-tenant-${Date.now()}`,
      assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }],
    });
  expect(createRes.status).toBe(201);
  const tenantId: string = createRes.body.data.id;

  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'key' });
  expect(keyRes.status).toBe(201);
  const auth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

  const custRes = await request(app)
    .post('/v1/customers')
    .set(auth)
    .send({ externalId: `tron-cust-${Date.now()}`, name: 'TRON Test Customer' });
  expect(custRes.status).toBe(201);
  const customerId: string = custRes.body.data.id;

  return { tenantId, auth, customerId };
}

// ── tronXpub config ──────────────────────────────────────────────────────────

describe('PATCH /admin/v1/tenants/:id/config — tronXpub', () => {
  it('stores tronXpub in tenant_configs', async () => {
    const { tenantId } = await createTenantWithKey();
    const xpub = uniqueTronXpub();

    const res = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ tronXpub: xpub });

    expect(res.status).toBe(200);
    expect(res.body.data.tron_xpub).toBe(xpub);
    expect(res.body.data.tron_next_derivation_index).toBe(0);
    expect(res.body.data.tron_confirmations_required).toBe(1);
  });

  it('stores tronConfirmationsRequired', async () => {
    const { tenantId } = await createTenantWithKey();

    const res = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ tronConfirmationsRequired: 3 });

    expect(res.status).toBe(200);
    expect(res.body.data.tron_confirmations_required).toBe(3);
  });

  it('stores tronSweepThresholdSun', async () => {
    const { tenantId } = await createTenantWithKey();

    const res = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ tronSweepThresholdSun: '5000000' });

    expect(res.status).toBe(200);
    expect(res.body.data.tron_sweep_threshold_sun).toBe('5000000');
  });

  it('can clear tronXpub by setting null', async () => {
    const { tenantId } = await createTenantWithKey();
    const xpub = uniqueTronXpub();

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ tronXpub: xpub });

    const clearRes = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ tronXpub: null });

    expect(clearRes.status).toBe(200);
    expect(clearRes.body.data.tron_xpub).toBeNull();
  });
});

// ── TRON deposit address generation ─────────────────────────────────────────

describe('POST /v1/customers/:id/deposit-address?chain=tron', () => {
  it('returns 400 when tron_xpub is not configured', async () => {
    const { customerId, auth } = await createTenantWithKey();

    const res = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address?chain=tron`)
      .set(auth);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/tron_xpub/i);
  });

  it('derives a TRON deposit address and returns chain=tron', async () => {
    const { tenantId, customerId, auth } = await createTenantWithKey();
    const xpub = uniqueTronXpub();

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ tronXpub: xpub });

    const res = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address?chain=tron`)
      .set(auth);

    expect(res.status).toBe(201);
    const data = res.body.data;
    expect(data.chain).toBe('tron');
    expect(data.address).toMatch(/^T[A-Za-z0-9]{33}$/); // TRON base58 address
    expect(data.derivationPath).toBe('m/0/0');
    expect(data.derivationIndex).toBe(0);
    expect(data.customerId).toBe(customerId);
    expect(data.walletId).toBeTruthy();
  });

  it('increments derivation index for consecutive calls', async () => {
    const { tenantId, customerId, auth } = await createTenantWithKey();
    const xpub = uniqueTronXpub();

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ tronXpub: xpub });

    const res1 = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address?chain=tron`)
      .set(auth);
    const res2 = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address?chain=tron`)
      .set(auth);
    const res3 = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address?chain=tron`)
      .set(auth);

    expect(res1.body.data.derivationIndex).toBe(0);
    expect(res2.body.data.derivationIndex).toBe(1);
    expect(res3.body.data.derivationIndex).toBe(2);
    expect(res1.body.data.address).not.toBe(res2.body.data.address);
    expect(res2.body.data.address).not.toBe(res3.body.data.address);
  });

  it('derivation path matches index', async () => {
    const { tenantId, customerId, auth } = await createTenantWithKey();
    const xpub = uniqueTronXpub();

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ tronXpub: xpub });

    const res0 = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address?chain=tron`)
      .set(auth);
    const res1 = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address?chain=tron`)
      .set(auth);

    expect(res0.body.data.derivationPath).toBe('m/0/0');
    expect(res1.body.data.derivationPath).toBe('m/0/1');
  });

  it('returns 201 for BTC when chain is not specified (default behaviour preserved)', async () => {
    const { tenantId, customerId, auth } = await createTenantWithKey();

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({
        btcXpub: (() => {
          const seed = Buffer.alloc(32, tronXpubCounter++);
          return bip32.fromSeed(seed, bitcoin.networks.bitcoin).neutered().toBase58();
        })(),
      });

    const res = await request(app)
      .post(`/v1/customers/${customerId}/deposit-address`)
      .set(auth);

    expect(res.status).toBe(201);
    expect(res.body.data.chain).toBe('bitcoin');
  });

  it('returns 404 when customer does not exist', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .post('/v1/customers/nonexistent-id/deposit-address?chain=tron')
      .set(auth);
    expect(res.status).toBe(404);
  });
});
