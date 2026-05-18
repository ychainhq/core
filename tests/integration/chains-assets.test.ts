import request from 'supertest';
import { bootstrapApp, AUTH, teardownDb } from './helpers';

const app = bootstrapApp();

afterAll(() => teardownDb());

describe('GET /v1/chains', () => {
  it('returns list with bitcoin chain seeded', async () => {
    const res = await request(app).get('/v1/chains').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);

    const btc = res.body.data.find((c: any) => c.id === 'bitcoin');
    expect(btc).toBeDefined();
    expect(btc.type).toBe('utxo');
    expect(btc.native_asset).toBe('BTC');
    expect(btc.specs).toBeDefined();
    expect(btc.specs.finality_type).toBe('confirmations');
    expect(btc.specs.evm_chain_id).toBeUndefined();
    expect(btc.finality_type).toBeUndefined();
    expect(btc.chain_id).toBeUndefined();
  });

  it('filters by enabled=true', async () => {
    const res = await request(app).get('/v1/chains?enabled=true').set(AUTH);
    expect(res.status).toBe(200);
    const allEnabled = res.body.data.every((c: any) => c.is_enabled === true);
    expect(allEnabled).toBe(true);
  });

  it('filters by type=utxo', async () => {
    const res = await request(app).get('/v1/chains?type=utxo').set(AUTH);
    expect(res.status).toBe(200);
    const allUtxo = res.body.data.every((c: any) => c.type === 'utxo');
    expect(allUtxo).toBe(true);
  });
});

describe('GET /v1/chains/:chain', () => {
  it('returns bitcoin chain details', async () => {
    const res = await request(app).get('/v1/chains/bitcoin').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('bitcoin');
    expect(res.body.data.name).toBe('Bitcoin');
    expect(res.body.data.type).toBe('utxo');
  });

  it('returns 404 for unknown chain', async () => {
    const res = await request(app).get('/v1/chains/solana').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/assets', () => {
  it('returns list with BTC asset seeded', async () => {
    const res = await request(app).get('/v1/assets').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);

    const btc = res.body.data.find((a: any) => a.id === 'bitcoin:BTC');
    expect(btc).toBeDefined();
    expect(btc.symbol).toBe('BTC');
    expect(btc.decimals).toBe(8);
    expect(btc.type).toBe('native');
    expect(btc.contract_address).toBeNull();
  });

  it('filters by chain=bitcoin', async () => {
    const res = await request(app).get('/v1/assets?chain=bitcoin').set(AUTH);
    expect(res.status).toBe(200);
    const allBitcoin = res.body.data.every((a: any) => a.chain_id === 'bitcoin');
    expect(allBitcoin).toBe(true);
  });

  it('filters by type=native', async () => {
    const res = await request(app).get('/v1/assets?type=native').set(AUTH);
    expect(res.status).toBe(200);
    const allNative = res.body.data.every((a: any) => a.type === 'native');
    expect(allNative).toBe(true);
  });
});

describe('GET /v1/chains/:chain/assets/:asset', () => {
  it('returns BTC asset details for bitcoin chain', async () => {
    const res = await request(app).get('/v1/chains/bitcoin/assets/BTC').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.symbol).toBe('BTC');
    expect(res.body.data.chain_id).toBe('bitcoin');
    expect(res.body.data.decimals).toBe(8);
  });

  it('returns 404 for unknown asset', async () => {
    const res = await request(app).get('/v1/chains/bitcoin/assets/USDC').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for unknown chain', async () => {
    const res = await request(app).get('/v1/chains/ethereum/assets/ETH').set(AUTH);
    expect(res.status).toBe(404);
  });
});
