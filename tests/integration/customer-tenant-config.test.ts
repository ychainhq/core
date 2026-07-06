/**
 * Integration tests for GET /v1/me/tenant-config
 *
 * Verifies:
 * - Auth: 401 without customer session token
 * - availableChains derived from btc_xpub / tron_xpub presence (NOT their values)
 * - Sensitive fields (xpubs, secrets, limits) never exposed to customer
 * - Numeric confirmation fields always present
 */

import request from 'supertest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr } from './helpers';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

jest.setTimeout(60000);

const app = bootstrapApp();
afterAll(() => teardownDb());

let xpubCounter = 200;
function uniqueXpub(): string {
  const seed = Buffer.alloc(32, xpubCounter++);
  return bip32.fromSeed(seed, bitcoin.networks.bitcoin).neutered().toBase58();
}

async function setupTenant(opts: { btcXpub?: boolean; tronXpub?: boolean } = {}): Promise<{
  tenantId: string;
  tenantAuth: { Authorization: string };
  customerId: string;
  sessionToken: string;
}> {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({
      name: `cfg-test-${Date.now()}-${Math.random()}`,
      assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }],
    });
  expect(createRes.status).toBe(201);
  const tenantId: string = createRes.body.data.id;

  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'k' });
  expect(keyRes.status).toBe(201);
  const tenantAuth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

  if (opts.btcXpub) {
    const r = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcXpub: uniqueXpub() });
    expect(r.status).toBe(200);
  }
  if (opts.tronXpub) {
    const r = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ tronXpub: uniqueXpub() });
    expect(r.status).toBe(200);
  }

  const custRes = await request(app)
    .post('/v1/customers')
    .set(tenantAuth)
    .send({ externalId: `c-${Date.now()}`, name: 'Test Customer' });
  expect(custRes.status).toBe(201);
  const customerId: string = custRes.body.data.id;

  const sessRes = await request(app)
    .post(`/v1/customers/${customerId}/sessions`)
    .set(tenantAuth)
    .send({});
  expect(sessRes.status).toBe(201);
  const sessionToken: string = sessRes.body.data.accessToken;

  return { tenantId, tenantAuth, customerId, sessionToken };
}

describe('GET /v1/me/tenant-config', () => {
  it('returns 401 without customer session token', async () => {
    const res = await request(app).get('/v1/me/tenant-config');
    expect(res.status).toBe(401);
  });

  it('returns empty availableChains when no xpubs configured', async () => {
    const { sessionToken } = await setupTenant();
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.availableChains).toEqual([]);
  });

  it('returns [bitcoin] when only btcXpub is configured', async () => {
    const { sessionToken } = await setupTenant({ btcXpub: true });
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.availableChains).toEqual(['bitcoin']);
  });

  it('returns [tron] when only tronXpub is configured', async () => {
    const { sessionToken } = await setupTenant({ tronXpub: true });
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.availableChains).toEqual(['tron']);
  });

  it('returns [bitcoin, tron] when both xpubs are configured', async () => {
    const { sessionToken } = await setupTenant({ btcXpub: true, tronXpub: true });
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.availableChains).toContain('bitcoin');
    expect(res.body.data.availableChains).toContain('tron');
    expect(res.body.data.availableChains).toHaveLength(2);
  });

  it('returns numeric confirmation fields', async () => {
    const { sessionToken } = await setupTenant();
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.btcConfirmationsRequired).toBe('number');
    expect(typeof res.body.data.tronConfirmationsRequired).toBe('number');
    expect(typeof res.body.data.customerSessionTtlSeconds).toBe('number');
  });

  it('does NOT expose xpub values, secrets, or internal limits', async () => {
    const { sessionToken } = await setupTenant({ btcXpub: true, tronXpub: true });
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).not.toHaveProperty('btc_xpub');
    expect(data).not.toHaveProperty('tron_xpub');
    expect(data).not.toHaveProperty('btcXpub');
    expect(data).not.toHaveProperty('tronXpub');
    expect(data).not.toHaveProperty('actor_token_secret');
    expect(data).not.toHaveProperty('daily_withdrawal_limit_sats');
    expect(data).not.toHaveProperty('btc_sweep_threshold_sats');
    expect(data).not.toHaveProperty('tron_sweep_threshold_sun');
  });

  // ── availableAssets ────────────────────────────────────────────────────────

  it('returns availableAssets as an array', async () => {
    const { sessionToken } = await setupTenant();
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.availableAssets)).toBe(true);
  });

  it('returns empty availableAssets when no xpubs configured', async () => {
    const { sessionToken } = await setupTenant();
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.availableAssets).toEqual([]);
  });

  it('returns bitcoin:BTC asset when btcXpub is configured', async () => {
    const { sessionToken } = await setupTenant({ btcXpub: true });
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    const assets = res.body.data.availableAssets;
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ chainId: 'bitcoin', assetId: 'bitcoin:BTC', symbol: 'BTC' });
  });

  it('returns tron:TRX asset when tronXpub is configured', async () => {
    const { sessionToken } = await setupTenant({ tronXpub: true });
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    const assets = res.body.data.availableAssets;
    // TRX always present when tron is configured
    expect(assets.some((a: any) => a.assetId === 'tron:TRX')).toBe(true);
    // tron:USDT presence depends on TRON_USDT_CONTRACT_ADDRESS env — test only verifies structure
    const usdtAsset = assets.find((a: any) => a.assetId === 'tron:USDT');
    if (usdtAsset) {
      expect(usdtAsset.chainId).toBe('tron');
      expect(typeof usdtAsset.symbol).toBe('string');
    }
  });

  it('returns both bitcoin:BTC and tron:TRX when both xpubs configured', async () => {
    const { sessionToken } = await setupTenant({ btcXpub: true, tronXpub: true });
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    const assetIds = res.body.data.availableAssets.map((a: any) => a.assetId);
    expect(assetIds).toContain('bitcoin:BTC');
    expect(assetIds).toContain('tron:TRX');
  });

  it('availableAssets items have required fields: chainId, assetId, symbol, label', async () => {
    const { sessionToken } = await setupTenant({ btcXpub: true, tronXpub: true });
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    for (const asset of res.body.data.availableAssets) {
      expect(typeof asset.chainId).toBe('string');
      expect(typeof asset.assetId).toBe('string');
      expect(typeof asset.symbol).toBe('string');
      expect(typeof asset.label).toBe('string');
    }
  });

  it('availableAssets does NOT expose contract addresses or internal secrets', async () => {
    const { sessionToken } = await setupTenant({ tronXpub: true });
    const res = await request(app)
      .get('/v1/me/tenant-config')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    for (const asset of res.body.data.availableAssets) {
      expect(asset).not.toHaveProperty('contractAddress');
      expect(asset).not.toHaveProperty('contract_address');
      expect(asset).not.toHaveProperty('xpub');
    }
  });
});
