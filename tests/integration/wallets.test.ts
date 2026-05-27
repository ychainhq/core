import request from 'supertest';
import crypto from 'crypto';
import { bootstrapApp, AUTH, ADDR_1, ADDR_2, teardownDb, uniqueAddr, TEST_TENANT_ID } from './helpers';
import { getDb } from '../../src/db/sqlite';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeActorToken(tenantId: string, secret: string, permissions: string[] = []): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(Buffer.from(JSON.stringify({
    sub: 'user_rbac_test',
    tenant_id: tenantId,
    permissions,
    teams: [],
    roles: [],
    iat: now,
    exp: now + 3600,
  })));
  const sig = base64url(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

const app = bootstrapApp();

afterAll(() => teardownDb());

describe('POST /v1/wallets', () => {
  it('creates a watch_only wallet', async () => {
    const res = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'My Test Wallet', type: 'watch_only' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toMatch(/^wallet_/);
    expect(res.body.data.name).toBe('My Test Wallet');
    expect(res.body.data.type).toBe('watch_only');
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.created_at).toBeDefined();
  });

  it('creates an external_signer wallet with metadata', async () => {
    const res = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Signer Wallet', type: 'external_signer', metadata: { merchantId: 'm123' } });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('external_signer');
  });

  it('returns 400 for missing name', async () => {
    const res = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ type: 'watch_only' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid type', async () => {
    const res = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Bad Type', type: 'custodial_magic' });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/wallets', () => {
  it('returns list of wallets', async () => {
    // Ensure at least one wallet exists
    await request(app).post('/v1/wallets').set(AUTH).send({ name: 'Listed Wallet', type: 'watch_only' });

    const res = await request(app).get('/v1/wallets').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.limit).toBeDefined();
  });

  it('returns empty list when no wallets match filter', async () => {
    const res = await request(app).get('/v1/wallets?type=multisig').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /v1/wallets/:walletId', () => {
  let walletId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Lookup Wallet', type: 'watch_only' });
    walletId = res.body.data.id;
  });

  it('returns wallet by id', async () => {
    const res = await request(app).get(`/v1/wallets/${walletId}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(walletId);
    expect(res.body.data.name).toBe('Lookup Wallet');
  });

  it('returns 404 for non-existent wallet', async () => {
    const res = await request(app).get('/v1/wallets/wallet_doesnotexist').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /v1/wallets/:walletId/addresses', () => {
  let walletId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Addr Wallet', type: 'watch_only' });
    walletId = res.body.data.id;
  });

  it('registers a valid BTC address', async () => {
    const res = await request(app)
      .post(`/v1/wallets/${walletId}/addresses`)
      .set(AUTH)
      .send({ chain: 'bitcoin', address: ADDR_1, label: 'Deposit #1' });

    expect(res.status).toBe(201);
    expect(res.body.data.address).toBe(ADDR_1);
    expect(res.body.data.chain_id).toBe('bitcoin');
    expect(res.body.data.wallet_id).toBe(walletId);
    expect(res.body.data.label).toBe('Deposit #1');
    expect(res.body.data.id).toMatch(/^addr_/);
  });

  it('returns 409 if address already registered for same chain', async () => {
    // Second registration of same address + chain
    const res = await request(app)
      .post(`/v1/wallets/${walletId}/addresses`)
      .set(AUTH)
      .send({ chain: 'bitcoin', address: ADDR_1 });
    expect(res.status).toBe(409);
  });

  it('returns 400 for invalid BTC address', async () => {
    const res = await request(app)
      .post(`/v1/wallets/${walletId}/addresses`)
      .set(AUTH)
      .send({ chain: 'bitcoin', address: 'notanaddress' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown wallet', async () => {
    const res = await request(app)
      .post('/v1/wallets/wallet_ghost/addresses')
      .set(AUTH)
      .send({ chain: 'bitcoin', address: ADDR_1 });
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown chain', async () => {
    const res = await request(app)
      .post(`/v1/wallets/${walletId}/addresses`)
      .set(AUTH)
      .send({ chain: 'ethereum', address: '0xabc' });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/wallets/:walletId/addresses', () => {
  let walletId: string;

  beforeAll(async () => {
    const wRes = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'List Addr Wallet', type: 'watch_only' });
    walletId = wRes.body.data.id;

    await request(app)
      .post(`/v1/wallets/${walletId}/addresses`)
      .set(AUTH)
      .send({ chain: 'bitcoin', address: ADDR_2, label: 'addr-one' });
  });

  it('returns addresses for the wallet', async () => {
    const res = await request(app).get(`/v1/wallets/${walletId}/addresses`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].address).toBe(ADDR_2);
    expect(res.body.data[0].label).toBe('addr-one');
  });

  it('returns empty for wallet with no addresses', async () => {
    const wRes = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Empty Wallet', type: 'watch_only' });
    const emptyId = wRes.body.data.id;

    const res = await request(app).get(`/v1/wallets/${emptyId}/addresses`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /v1/wallets/:walletId/balances', () => {
  it('returns 404 for non-existent wallet', async () => {
    const res = await request(app).get('/v1/wallets/wallet_nonexistent/balances').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns empty balances map for wallet with no addresses', async () => {
    const wRes = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'No-Addr Balance Wallet', type: 'watch_only' });
    const walletId = wRes.body.data.id;

    const res = await request(app).get(`/v1/wallets/${walletId}/balances`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.walletId).toBe(walletId);
    expect(res.body.data.balances).toEqual({});
  });

  it('returns bitcoin chain entry for wallet with addresses (Core unavailable — zero totals)', async () => {
    const wRes = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'With-Addr Balance Wallet', type: 'watch_only' });
    const walletId = wRes.body.data.id;

    await request(app)
      .post(`/v1/wallets/${walletId}/addresses`)
      .set(AUTH)
      .send({ chain: 'bitcoin', address: uniqueAddr() });

    const res = await request(app).get(`/v1/wallets/${walletId}/balances`).set(AUTH);
    // Bitcoin Core is unavailable in the test environment; the router silently skips
    // failed addresses and returns zero totals for the chain.
    expect(res.status).toBe(200);
    expect(res.body.data.walletId).toBe(walletId);
    expect(res.body.data.balances.bitcoin).toBeDefined();
    expect(res.body.data.balances.bitcoin.confirmed).toBeDefined();
    expect(res.body.data.balances.bitcoin.unconfirmed).toBeDefined();
    expect(res.body.data.balances.bitcoin.total).toBeDefined();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/wallets/wallet_any/balances');
    expect(res.status).toBe(401);
  });
});

// ─── RBAC guard — wallet:read ──────────────────────────────────────────────────

const ACTOR_SECRET_WAL = 'rbac-wallet-secret-at-least-32-chars-here!!';

describe('Wallets — RBAC guard (X-Actor-Token)', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare(`UPDATE tenant_configs SET actor_token_secret = ? WHERE tenant_id = ?`)
      .run(ACTOR_SECRET_WAL, TEST_TENANT_ID);
  });

  it('GET /v1/wallets with token lacking wallet:read → 403', async () => {
    const token = makeActorToken(TEST_TENANT_ID, ACTOR_SECRET_WAL, []);
    const res = await request(app)
      .get('/v1/wallets')
      .set({ ...AUTH, 'X-Actor-Token': token });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('GET /v1/wallets with wallet:read:all → 200', async () => {
    const token = makeActorToken(TEST_TENANT_ID, ACTOR_SECRET_WAL, ['wallet:read:all']);
    const res = await request(app)
      .get('/v1/wallets')
      .set({ ...AUTH, 'X-Actor-Token': token });

    expect(res.status).toBe(200);
  });

  it('GET /v1/wallets without X-Actor-Token → 200 (admin mode)', async () => {
    const res = await request(app)
      .get('/v1/wallets')
      .set(AUTH);

    expect(res.status).toBe(200);
  });

  it('unrelated permission (withdrawal-batch:read:all) still yields 403 for wallet', async () => {
    const token = makeActorToken(TEST_TENANT_ID, ACTOR_SECRET_WAL, ['withdrawal-batch:read:all']);
    const res = await request(app)
      .get('/v1/wallets')
      .set({ ...AUTH, 'X-Actor-Token': token });

    expect(res.status).toBe(403);
  });
});
