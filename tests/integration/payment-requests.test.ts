import request from 'supertest';
import { bootstrapApp, AUTH, ADDR_1, ADDR_2, teardownDb } from './helpers';

const app = bootstrapApp();

// Shared wallet + address for payment request tests
let walletId: string;

afterAll(() => teardownDb());

beforeAll(async () => {
  const wRes = await request(app)
    .post('/v1/wallets')
    .set(AUTH)
    .send({ name: 'PR Test Wallet', type: 'watch_only' });
  walletId = wRes.body.data.id;

  await request(app)
    .post(`/v1/wallets/${walletId}/addresses`)
    .set(AUTH)
    .send({ chain: 'bitcoin', address: ADDR_1 });
});

describe('POST /v1/payment-requests', () => {
  it('creates a payment request with explicit address', async () => {
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({
        chain: 'bitcoin',
        asset: 'BTC',
        amount: '0.001',
        address: ADDR_1,
        reference: 'order_001',
        confirmationsRequired: 2,
      });

    expect(res.status).toBe(201);
    const pr = res.body.data;
    expect(pr.id).toMatch(/^payreq_/);
    expect(pr.chain_id).toBe('bitcoin');
    expect(pr.asset_id).toBe('bitcoin:BTC');
    expect(pr.address).toBe(ADDR_1);
    expect(pr.amount_raw).toBe('100000'); // 0.001 BTC = 100_000 sat
    expect(pr.amount_display).toBe('0.00100000');
    expect(pr.reference).toBe('order_001');
    expect(pr.status).toBe('pending');
    expect(pr.confirmations_required).toBe(2);
    expect(pr.qr_payload).toBe(
      `bitcoin:${ADDR_1}?amount=0.00100000&label=order_001&message=order_001`
    );
    expect(pr.created_at).toBeDefined();
  });

  it('resolves address from walletId when no address given', async () => {
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({
        chain: 'bitcoin',
        asset: 'BTC',
        amount: '0.005',
        walletId,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.address).toBe(ADDR_1);
    expect(res.body.data.wallet_id).toBe(walletId);
  });

  it('returns 400 when no address and no walletId', async () => {
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({ chain: 'bitcoin', asset: 'BTC', amount: '0.001' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid amount (non-numeric)', async () => {
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({ chain: 'bitcoin', asset: 'BTC', amount: 'abc', address: ADDR_1 });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown chain', async () => {
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({ chain: 'solana', asset: 'SOL', amount: '1', address: ADDR_1 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for unknown asset', async () => {
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({ chain: 'bitcoin', asset: 'USDC', amount: '1', address: ADDR_1 });
    expect(res.status).toBe(404);
  });

  it('stores expiresAt correctly', async () => {
    const expiresAt = '2030-12-31T23:59:59Z';
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({ chain: 'bitcoin', asset: 'BTC', amount: '0.01', address: ADDR_1, expiresAt });

    expect(res.status).toBe(201);
    expect(res.body.data.expires_at).toBe(expiresAt);
  });
});

describe('Idempotency — POST /v1/payment-requests', () => {
  const idemKey = `idem-test-pr-${Date.now()}`;

  it('returns same result on second call with same Idempotency-Key', async () => {
    const body = { chain: 'bitcoin', asset: 'BTC', amount: '0.002', address: ADDR_1, reference: `idem-${Date.now()}` };

    const first = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .set('Idempotency-Key', idemKey)
      .send(body);

    expect(first.status).toBe(201);

    // Second call with same key but different body — should return first result
    const second = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .set('Idempotency-Key', idemKey)
      .send({ chain: 'bitcoin', asset: 'BTC', amount: '9.999', address: ADDR_2 });

    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.amount_raw).toBe(first.body.data.amount_raw);
  });

  it('different Idempotency-Key creates separate resources', async () => {
    const body = { chain: 'bitcoin', asset: 'BTC', amount: '0.003', address: ADDR_1 };

    const first = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .set('Idempotency-Key', `key-A-${Date.now()}`)
      .send(body);

    const second = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .set('Idempotency-Key', `key-B-${Date.now()}`)
      .send(body);

    expect(first.body.data.id).not.toBe(second.body.data.id);
  });
});

describe('GET /v1/payment-requests', () => {
  beforeAll(async () => {
    // Create a few payment requests for listing tests
    await request(app).post('/v1/payment-requests').set(AUTH).send({
      chain: 'bitcoin', asset: 'BTC', amount: '0.01', address: ADDR_1, reference: 'list-test-1',
    });
    await request(app).post('/v1/payment-requests').set(AUTH).send({
      chain: 'bitcoin', asset: 'BTC', amount: '0.02', address: ADDR_1, reference: 'list-test-2',
    });
  });

  it('returns list with pagination', async () => {
    const res = await request(app).get('/v1/payment-requests').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination).toMatchObject({ limit: expect.any(Number) });
  });

  it('filters by status=pending', async () => {
    const res = await request(app).get('/v1/payment-requests?status=pending').set(AUTH);
    expect(res.status).toBe(200);
    const allPending = res.body.data.every((pr: any) => pr.status === 'pending');
    expect(allPending).toBe(true);
  });

  it('filters by chain=bitcoin', async () => {
    const res = await request(app).get('/v1/payment-requests?chain=bitcoin').set(AUTH);
    expect(res.status).toBe(200);
    const allBitcoin = res.body.data.every((pr: any) => pr.chain_id === 'bitcoin');
    expect(allBitcoin).toBe(true);
  });

  it('filters by reference', async () => {
    const res = await request(app)
      .get('/v1/payment-requests?reference=list-test-1')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].reference).toBe('list-test-1');
  });

  it('respects limit parameter', async () => {
    const res = await request(app).get('/v1/payment-requests?limit=1').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
  });
});

describe('GET /v1/payment-requests/:id', () => {
  let prId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({ chain: 'bitcoin', asset: 'BTC', amount: '0.005', address: ADDR_1 });
    prId = res.body.data.id;
  });

  it('returns payment request by id', async () => {
    const res = await request(app).get(`/v1/payment-requests/${prId}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(prId);
  });

  it('returns 404 for non-existent id', async () => {
    const res = await request(app).get('/v1/payment-requests/payreq_nonexistent').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/payment-requests/by-reference/:reference', () => {
  const ref = `by-ref-test-${Date.now()}`;

  beforeAll(async () => {
    await request(app).post('/v1/payment-requests').set(AUTH).send({
      chain: 'bitcoin', asset: 'BTC', amount: '0.001', address: ADDR_1, reference: ref,
    });
  });

  it('returns payment requests matching reference', async () => {
    const res = await request(app)
      .get(`/v1/payment-requests/by-reference/${ref}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].reference).toBe(ref);
  });

  it('returns empty array for unknown reference', async () => {
    const res = await request(app)
      .get('/v1/payment-requests/by-reference/no-such-ref')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /v1/payment-requests/:id/qr', () => {
  let prId: string;
  let expectedQr: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({ chain: 'bitcoin', asset: 'BTC', amount: '0.001', address: ADDR_1, reference: 'qr-test' });
    prId = res.body.data.id;
    expectedQr = res.body.data.qr_payload;
  });

  it('returns qr_payload for format=payload', async () => {
    const res = await request(app)
      .get(`/v1/payment-requests/${prId}/qr?format=payload`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.qrPayload).toBe(expectedQr);
    expect(expectedQr).toMatch(/^bitcoin:/);
  });

  it('returns 200 with payload when format is omitted', async () => {
    const res = await request(app)
      .get(`/v1/payment-requests/${prId}/qr`)
      .set(AUTH);
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/payment-requests/:id/cancel', () => {
  let prId: string;

  beforeEach(async () => {
    const res = await request(app)
      .post('/v1/payment-requests')
      .set(AUTH)
      .send({ chain: 'bitcoin', asset: 'BTC', amount: '0.001', address: ADDR_1 });
    prId = res.body.data.id;
  });

  it('cancels a pending payment request', async () => {
    const res = await request(app)
      .post(`/v1/payment-requests/${prId}/cancel`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });

  it('returns 409 when trying to cancel an already cancelled request', async () => {
    await request(app).post(`/v1/payment-requests/${prId}/cancel`).set(AUTH);

    const res = await request(app)
      .post(`/v1/payment-requests/${prId}/cancel`)
      .set(AUTH);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 404 for non-existent payment request', async () => {
    const res = await request(app)
      .post('/v1/payment-requests/payreq_ghost/cancel')
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});
