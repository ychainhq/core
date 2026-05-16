import request from 'supertest';
import { bootstrapApp, AUTH, ADDR_1, ADDR_2, ADDR_3, ADDR_LEGACY, teardownDb } from './helpers';

const app = bootstrapApp();

afterAll(() => teardownDb());

describe('POST /v1/chains/:chain/addresses/validate', () => {
  it('validates a valid bech32 (P2WPKH) address', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/addresses/validate')
      .set(AUTH)
      .send({ address: ADDR_1 });

    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.address).toBe(ADDR_1);
    expect(res.body.data.chain).toBe('bitcoin');
    expect(res.body.data.format).toBe('p2wpkh');
  });

  it('validates a valid bech32 (P2WPKH) second address', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/addresses/validate')
      .set(AUTH)
      .send({ address: ADDR_2 });

    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
  });

  it('validates a legacy P2PKH address', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/addresses/validate')
      .set(AUTH)
      .send({ address: ADDR_LEGACY });

    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.format).toBe('p2pkh');
  });

  it('rejects invalid address', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/addresses/validate')
      .set(AUTH)
      .send({ address: 'notanaddress' });

    expect(res.status).toBe(200); // validate always returns 200, with valid=false
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.format).toBeUndefined();
  });

  it('rejects empty address with 400', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/addresses/validate')
      .set(AUTH)
      .send({ address: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when address field missing', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/addresses/validate')
      .set(AUTH)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /v1/monitors/addresses', () => {
  it('adds an address to monitoring', async () => {
    const res = await request(app)
      .post('/v1/monitors/addresses')
      .set(AUTH)
      .send({ chain: 'bitcoin', address: ADDR_1, label: 'test-monitor', events: ['incoming'] });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toMatch(/^mon_/);
    expect(res.body.data.address).toBe(ADDR_1);
    expect(res.body.data.chain_id).toBe('bitcoin');
    expect(res.body.data.is_active).toBe(true);
    expect(res.body.data.events).toContain('incoming');
  });

  it('adds monitoring with walletId', async () => {
    const wRes = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Mon Wallet', type: 'watch_only' });
    const walletId = wRes.body.data.id;

    const res = await request(app)
      .post('/v1/monitors/addresses')
      .set(AUTH)
      .send({ chain: 'bitcoin', address: ADDR_2, walletId, label: 'with-wallet' });

    expect(res.status).toBe(201);
    expect(res.body.data.wallet_id).toBe(walletId);
  });

  it('returns 400 for missing chain', async () => {
    const res = await request(app)
      .post('/v1/monitors/addresses')
      .set(AUTH)
      .send({ address: ADDR_1 });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid address', async () => {
    const res = await request(app)
      .post('/v1/monitors/addresses')
      .set(AUTH)
      .send({ chain: 'bitcoin', address: 'bad_addr' });

    expect(res.status).toBe(400);
  });
});

describe('GET /v1/monitors/addresses', () => {
  beforeAll(async () => {
    await request(app)
      .post('/v1/monitors/addresses')
      .set(AUTH)
      .send({ chain: 'bitcoin', address: ADDR_1, label: 'list-test' });
  });

  it('returns list of monitored addresses', async () => {
    const res = await request(app).get('/v1/monitors/addresses').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by chain', async () => {
    const res = await request(app).get('/v1/monitors/addresses?chain=bitcoin').set(AUTH);
    expect(res.status).toBe(200);
    const allBitcoin = res.body.data.every((m: any) => m.chain_id === 'bitcoin');
    expect(allBitcoin).toBe(true);
  });
});

describe('DELETE /v1/monitors/addresses/:monitorId', () => {
  let monitorId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/monitors/addresses')
      .set(AUTH)
      .send({ chain: 'bitcoin', address: ADDR_3, label: 'to-delete' });
    monitorId = res.body.data.id;
  });

  it('soft-deletes the monitor', async () => {
    const delRes = await request(app)
      .delete(`/v1/monitors/addresses/${monitorId}`)
      .set(AUTH);
    expect(delRes.status).toBe(200);

    // After delete, it should not appear in active list
    const listRes = await request(app)
      .get('/v1/monitors/addresses?chain=bitcoin')
      .set(AUTH);
    const found = listRes.body.data.find((m: any) => m.id === monitorId);
    expect(found).toBeUndefined();
  });

  it('returns 404 for non-existent monitor', async () => {
    const res = await request(app)
      .delete('/v1/monitors/addresses/mon_nonexistent')
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});
