/**
 * Bitcoin-specific endpoints.
 *
 * Endpoints that call Bitcoin Core return predictable error shapes when Core is
 * unavailable.  Fees has a built-in fallback and always returns 200.
 * Broadcast and prepare are tested at the validation layer (bad inputs → 400).
 */
import request from 'supertest';
import { bootstrapApp, AUTH, ADDR_1, ADDR_2, teardownDb } from './helpers';

const app = bootstrapApp();

afterAll(() => teardownDb());

describe('GET /v1/chains/bitcoin/fees', () => {
  it('returns 200 with sat/vbyte fee structure (fallback values when Core unavailable)', async () => {
    const res = await request(app).get('/v1/chains/bitcoin/fees').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.unit).toBe('sat/vbyte');
    expect(res.body.data.feeRates.low.feeRate).toBeGreaterThan(0);
    expect(res.body.data.feeRates.normal.feeRate).toBeGreaterThan(0);
    expect(res.body.data.feeRates.high.feeRate).toBeGreaterThan(0);
    expect(res.body.data.feeRates.high.feeRate).toBeGreaterThanOrEqual(
      res.body.data.feeRates.normal.feeRate
    );
    expect(res.body.data.feeRates.normal.feeRate).toBeGreaterThanOrEqual(
      res.body.data.feeRates.low.feeRate
    );
    expect(res.body.data.timestamp).toBeDefined();
  });

  it('accepts priority query param without error', async () => {
    const res = await request(app)
      .get('/v1/chains/bitcoin/fees?priority=high')
      .set(AUTH);
    expect(res.status).toBe(200);
  });

  it('accepts targetBlocks query param', async () => {
    const res = await request(app)
      .get('/v1/chains/bitcoin/fees?targetBlocks=3')
      .set(AUTH);
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid priority', async () => {
    const res = await request(app)
      .get('/v1/chains/bitcoin/fees?priority=turbo')
      .set(AUTH);
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/chains/bitcoin/addresses/:address/balances', () => {
  it('returns error with correct shape when Bitcoin Core is unavailable', async () => {
    const res = await request(app)
      .get(`/v1/chains/bitcoin/addresses/${ADDR_1}/balances`)
      .set(AUTH);

    // Must be an error response (Bitcoin Core not available in test env)
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBeDefined();
    expect(res.body.error.message).toBeDefined();
    // Must NOT be an auth error
    expect(res.body.error.code).not.toBe('UNAUTHORIZED');
  });
});

describe('GET /v1/chains/bitcoin/addresses/:address/balances/:asset', () => {
  it('returns correct error shape for BTC balance when Core unavailable', async () => {
    const res = await request(app)
      .get(`/v1/chains/bitcoin/addresses/${ADDR_1}/balances/BTC`)
      .set(AUTH);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).not.toBe('UNAUTHORIZED');
  });

  it('returns 404 for unknown asset symbol', async () => {
    const res = await request(app)
      .get(`/v1/chains/bitcoin/addresses/${ADDR_1}/balances/USDC`)
      .set(AUTH);
    // USDC is not a known bitcoin asset — must 404 before reaching Core
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/chains/bitcoin/addresses/:address/utxos', () => {
  it('returns error with correct shape when Bitcoin Core unavailable', async () => {
    const res = await request(app)
      .get(`/v1/chains/bitcoin/addresses/${ADDR_1}/utxos`)
      .set(AUTH);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).not.toBe('UNAUTHORIZED');
  });

  it('accepts minConfirmations query param', async () => {
    const res = await request(app)
      .get(`/v1/chains/bitcoin/addresses/${ADDR_1}/utxos?minConfirmations=1`)
      .set(AUTH);
    // Will fail due to no Core, but query param parsing should not cause 400
    expect(res.status).not.toBe(400);
  });
});

describe('POST /v1/chains/bitcoin/transactions/coin-selection', () => {
  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/coin-selection')
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for empty fromAddresses', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/coin-selection')
      .set(AUTH)
      .send({
        fromAddresses: [],
        outputs: [{ address: ADDR_2, amount: '100000' }],
        feeRate: 5,
        changeAddress: ADDR_1,
      });
    expect(res.status).toBe(400);
  });

  it('returns error (not 400) when Bitcoin Core unavailable but input valid', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/coin-selection')
      .set(AUTH)
      .send({
        fromAddresses: [ADDR_1],
        outputs: [{ address: ADDR_2, amount: '100000' }],
        feeRate: 5,
        changeAddress: ADDR_1,
      });
    // Input is valid — failure is Core being unavailable (not 400)
    expect(res.status).not.toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).not.toBe('VALIDATION_ERROR');
  });
});

describe('POST /v1/chains/bitcoin/transactions/prepare', () => {
  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/prepare')
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid format value', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/prepare')
      .set(AUTH)
      .send({
        fromAddresses: [ADDR_1],
        outputs: [{ address: ADDR_2, amount: '100000' }],
        changeAddress: ADDR_1,
        format: 'invalid_format',
      });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/chains/bitcoin/transactions/broadcast', () => {
  it('returns 400 for empty rawTransaction', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/broadcast')
      .set(AUTH)
      .send({ rawTransaction: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for clearly invalid hex', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/broadcast')
      .set(AUTH)
      .send({ rawTransaction: 'not-hex-at-all' });
    // Will fail at decode step — either 400 validation or error from Core
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBeDefined();
  });

  it('is idempotent with Idempotency-Key', async () => {
    const idemKey = `broadcast-idem-${Date.now()}`;
    const body = { rawTransaction: 'deadbeef' }; // invalid but same key

    const first = await request(app)
      .post('/v1/chains/bitcoin/transactions/broadcast')
      .set(AUTH)
      .set('Idempotency-Key', idemKey)
      .send(body);

    const second = await request(app)
      .post('/v1/chains/bitcoin/transactions/broadcast')
      .set(AUTH)
      .set('Idempotency-Key', idemKey)
      .send(body);

    // Both should return the same status and same body
    expect(second.status).toBe(first.status);
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
  });
});

describe('POST /v1/chains/bitcoin/transactions/validate', () => {
  it('returns 400 for empty rawTransaction', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/validate')
      .set(AUTH)
      .send({ rawTransaction: '' });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/chains/bitcoin/transactions/finalize', () => {
  it('returns 400 for missing psbt', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/finalize')
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns error for invalid PSBT base64 (not 400 for field, but decode error)', async () => {
    const res = await request(app)
      .post('/v1/chains/bitcoin/transactions/finalize')
      .set(AUTH)
      .send({ psbt: 'definitely-not-valid-psbt-base64!!!' });
    // Schema validation passes (psbt is a string), error comes from Core/decode
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('GET /v1/chains/:chain/transactions/:txHash/status', () => {
  it('returns error for unknown txHash (Core unavailable)', async () => {
    const txHash = 'a'.repeat(64); // 64-char hex looks like a valid txid
    const res = await request(app)
      .get(`/v1/chains/bitcoin/transactions/${txHash}/status`)
      .set(AUTH);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).not.toBe('UNAUTHORIZED');
  });
});

describe('GET /v1/chains/:chain/transactions/:txHash', () => {
  it('returns error for unknown txHash (Core unavailable)', async () => {
    const txHash = 'b'.repeat(64);
    const res = await request(app)
      .get(`/v1/chains/bitcoin/transactions/${txHash}`)
      .set(AUTH);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('GET /v1/wallets/:walletId/utxos', () => {
  it('returns 404 for non-existent wallet', async () => {
    const res = await request(app)
      .get('/v1/wallets/wallet_nonexistent/utxos')
      .set(AUTH);
    expect(res.status).toBe(404);
  });

  it('returns empty list for wallet with no addresses', async () => {
    const wRes = await request(app)
      .post('/v1/wallets')
      .set(AUTH)
      .send({ name: 'Empty UTXO Wallet', type: 'watch_only' });
    const walletId = wRes.body.data.id;

    const res = await request(app)
      .get(`/v1/wallets/${walletId}/utxos`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
