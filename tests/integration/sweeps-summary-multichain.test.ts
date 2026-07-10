/**
 * Integration tests for multi-chain sweep summary and list filtering.
 *
 * Covers:
 * - GET /v1/sweeps/summary?chainId=bitcoin  — BTC path (threshold_raw, total_utxos)
 * - GET /v1/sweeps/summary?chainId=tron&assetId=tron:TRX  — TRON TRX path
 * - GET /v1/sweeps/summary?chainId=tron&assetId=tron:USDT — TRON USDT path
 * - Unknown chainId → 400
 * - Default params (no query) → bitcoin path (backward-compat)
 * - GET /v1/sweeps?chainId= filter
 * - GET /v1/sweeps?assetId= filter
 */
import request from 'supertest';
import { getDb } from '../../src/db/sqlite';
import { bootstrapApp, AUTH, teardownDb, uniqueAddr } from './helpers';

const app = bootstrapApp();
afterAll(() => teardownDb());

// ─── helpers ────────────────────────────────────────────────────────────────

function insertCachedUtxo(address: string, amountRaw: string) {
  const db = getDb();
  const now = new Date().toISOString();
  // Reuse the seed's customer_deposits wallet for tenant_default
  const walletRow = db.prepare(
    "SELECT id FROM wallets WHERE tenant_id = 'tenant_default' AND wallet_role = 'customer_deposits' LIMIT 1"
  ).get() as { id: string } | undefined;
  const walletId = walletRow?.id ?? null;
  db.prepare(`
    INSERT OR IGNORE INTO cached_utxos
      (id, tenant_id, wallet_id, chain_id, wallet_role, address, tx_hash, vout, amount_raw,
       confirmations, is_spent, is_locked, created_at, updated_at)
    VALUES (?, 'tenant_default', ?, 'bitcoin', 'customer_deposits', ?, ?, 0, ?,
            6, 0, 0, ?, ?)
  `).run(`utxo_mc_${Math.random().toString(36).slice(2)}`, walletId, address, `hash_mc_${Math.random().toString(36).slice(2)}`, amountRaw, now, now);
}

function insertTronBalance(address: string, assetId: string, balanceRaw: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO tron_account_balances
      (address, asset_id, balance_raw, block_number, updated_at)
    VALUES (?, ?, ?, 1000, ?)
  `).run(address, assetId, balanceRaw, now);
}

function insertDepositAddress(address: string, chainId: string, walletRole = 'customer_deposits') {
  const db = getDb();
  const now = new Date().toISOString();
  const walletId = `wal_test_${chainId}_${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT OR IGNORE INTO wallets (id, tenant_id, name, wallet_role, type, status, created_at, updated_at)
    VALUES (?, 'tenant_default', ?, ?, 'watch_only', 'active', ?, ?)
  `).run(walletId, `${chainId} test wallet ${walletRole}`, walletRole, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO addresses (id, wallet_id, tenant_id, chain_id, address, status, created_at, updated_at)
    VALUES (?, ?, 'tenant_default', ?, ?, 'active', ?, ?)
  `).run(`addr_${Math.random().toString(36).slice(2)}`, walletId, chainId, address, now, now);
  return walletId;
}

function insertSweep(chainId: string, assetId: string, status = 'confirmed') {
  const db = getDb();
  const now = new Date().toISOString();
  const id = `sweep_mc_${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO sweeps
      (id, tenant_id, chain_id, asset_id, from_addresses, to_address, amount_raw, fee_raw, psbt, status, created_at, updated_at)
    VALUES (?, 'tenant_default', ?, ?, '[]', 'dest_addr', '1000', '100', NULL, ?, ?, ?)
  `).run(id, chainId, assetId, status, now, now);
  return id;
}

// ─── GET /v1/sweeps/summary — bitcoin (default) ──────────────────────────────

describe('GET /v1/sweeps/summary — bitcoin', () => {
  test('returns 200 with chain_id and asset_id', async () => {
    const res = await request(app).get('/v1/sweeps/summary').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.chain_id).toBe('bitcoin');
    expect(res.body.data.asset_id).toBe('bitcoin:BTC');
  });

  test('default (no params) returns bitcoin summary', async () => {
    const res = await request(app).get('/v1/sweeps/summary').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.chain_id).toBe('bitcoin');
  });

  test('threshold_raw comes from btc_sweep_threshold_sats in tenant_configs', async () => {
    const db = getDb();
    db.prepare("UPDATE tenant_configs SET btc_sweep_threshold_sats = '50000' WHERE tenant_id = 'tenant_default'").run();

    const res = await request(app).get('/v1/sweeps/summary?chainId=bitcoin&assetId=bitcoin:BTC').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.threshold_raw).toBe('50000');

    db.prepare("UPDATE tenant_configs SET btc_sweep_threshold_sats = '0' WHERE tenant_id = 'tenant_default'").run();
  });

  test('total_utxos is a number (not null) for bitcoin', async () => {
    const addr = uniqueAddr();
    insertDepositAddress(addr, 'bitcoin');
    insertCachedUtxo(addr, '10000');

    const res = await request(app).get('/v1/sweeps/summary?chainId=bitcoin').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.total_utxos).not.toBeNull();
    expect(typeof res.body.data.total_utxos).toBe('number');
  });

  test('current_total_raw sums unspent unlocked UTXOs', async () => {
    const db = getDb();
    const addr = uniqueAddr();
    insertDepositAddress(addr, 'bitcoin');
    insertCachedUtxo(addr, '30000');
    insertCachedUtxo(addr, '20000');

    const res = await request(app).get('/v1/sweeps/summary?chainId=bitcoin').set(AUTH);
    expect(res.status).toBe(200);
    const totalRaw = BigInt(res.body.data.current_total_raw);
    expect(totalRaw).toBeGreaterThanOrEqual(50000n);
  });
});

// ─── GET /v1/sweeps/summary — tron:TRX ──────────────────────────────────────

describe('GET /v1/sweeps/summary — tron:TRX', () => {
  test('returns 200 with chain_id=tron and asset_id=tron:TRX', async () => {
    const res = await request(app)
      .get('/v1/sweeps/summary?chainId=tron&assetId=tron:TRX')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.chain_id).toBe('tron');
    expect(res.body.data.asset_id).toBe('tron:TRX');
  });

  test('total_utxos is null for tron', async () => {
    const res = await request(app)
      .get('/v1/sweeps/summary?chainId=tron&assetId=tron:TRX')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.total_utxos).toBeNull();
  });

  test('current_total_raw sums tron_account_balances for TRX', async () => {
    const tronAddr1 = 'TAddr1TestMultichain1111111111111';
    const tronAddr2 = 'TAddr2TestMultichain2222222222222';
    insertDepositAddress(tronAddr1, 'tron');
    insertDepositAddress(tronAddr2, 'tron');
    insertTronBalance(tronAddr1, 'tron:TRX', '1000000000');
    insertTronBalance(tronAddr2, 'tron:TRX', '500000000');

    const res = await request(app)
      .get('/v1/sweeps/summary?chainId=tron&assetId=tron:TRX')
      .set(AUTH);
    expect(res.status).toBe(200);
    const totalRaw = BigInt(res.body.data.current_total_raw);
    expect(totalRaw).toBeGreaterThanOrEqual(1500000000n);
  });

  test('threshold_raw from tron_trx_sweep_threshold_sun', async () => {
    const db = getDb();
    db.prepare("UPDATE tenant_configs SET tron_trx_sweep_threshold_sun = '200000000' WHERE tenant_id = 'tenant_default'").run();

    const res = await request(app)
      .get('/v1/sweeps/summary?chainId=tron&assetId=tron:TRX')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.threshold_raw).toBe('200000000');

    db.prepare("UPDATE tenant_configs SET tron_trx_sweep_threshold_sun = NULL WHERE tenant_id = 'tenant_default'").run();
  });
});

// ─── GET /v1/sweeps/summary — tron:USDT ─────────────────────────────────────

describe('GET /v1/sweeps/summary — tron:USDT', () => {
  test('returns 200 with asset_id=tron:USDT', async () => {
    const res = await request(app)
      .get('/v1/sweeps/summary?chainId=tron&assetId=tron:USDT')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.asset_id).toBe('tron:USDT');
  });

  test('threshold_raw from tron_usdt_sweep_threshold_sun', async () => {
    const db = getDb();
    db.prepare("UPDATE tenant_configs SET tron_usdt_sweep_threshold_sun = '500000' WHERE tenant_id = 'tenant_default'").run();

    const res = await request(app)
      .get('/v1/sweeps/summary?chainId=tron&assetId=tron:USDT')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.threshold_raw).toBe('500000');

    db.prepare("UPDATE tenant_configs SET tron_usdt_sweep_threshold_sun = NULL WHERE tenant_id = 'tenant_default'").run();
  });

  test('current_total_raw sums tron_account_balances for USDT', async () => {
    const usdtAddr = 'TAddrUsdtTestMultichain333333333';
    insertDepositAddress(usdtAddr, 'tron');
    insertTronBalance(usdtAddr, 'tron:USDT', '5000000');

    const res = await request(app)
      .get('/v1/sweeps/summary?chainId=tron&assetId=tron:USDT')
      .set(AUTH);
    expect(res.status).toBe(200);
    const totalRaw = BigInt(res.body.data.current_total_raw);
    expect(totalRaw).toBeGreaterThanOrEqual(5000000n);
  });
});

// ─── unknown chainId ─────────────────────────────────────────────────────────

describe('GET /v1/sweeps/summary — unknown chainId', () => {
  test('returns 400 for unknown chainId', async () => {
    const res = await request(app)
      .get('/v1/sweeps/summary?chainId=ethereum')
      .set(AUTH);
    expect(res.status).toBe(400);
  });
});

// ─── GET /v1/sweeps — chain/asset filters ────────────────────────────────────

describe('GET /v1/sweeps — chainId/assetId filter', () => {
  test('chainId=bitcoin returns only bitcoin sweeps', async () => {
    insertSweep('bitcoin', 'bitcoin:BTC');
    insertSweep('tron', 'tron:TRX');

    const res = await request(app)
      .get('/v1/sweeps?chainId=bitcoin')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.every((s: any) => s.chain_id === 'bitcoin')).toBe(true);
  });

  test('chainId=tron returns only tron sweeps', async () => {
    insertSweep('tron', 'tron:TRX');

    const res = await request(app)
      .get('/v1/sweeps?chainId=tron')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.every((s: any) => s.chain_id === 'tron')).toBe(true);
  });

  test('assetId=tron:USDT returns only USDT sweeps', async () => {
    insertSweep('tron', 'tron:USDT');
    insertSweep('tron', 'tron:TRX');

    const res = await request(app)
      .get('/v1/sweeps?chainId=tron&assetId=tron:USDT')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.every((s: any) => s.asset_id === 'tron:USDT')).toBe(true);
  });

  test('no chain filter returns sweeps from all chains', async () => {
    insertSweep('bitcoin', 'bitcoin:BTC');
    insertSweep('tron', 'tron:TRX');

    const res = await request(app).get('/v1/sweeps').set(AUTH);
    expect(res.status).toBe(200);
    const chainIds = res.body.data.map((s: any) => s.chain_id);
    expect(chainIds).toContain('bitcoin');
    expect(chainIds).toContain('tron');
  });

  test('pending_sweep_id in summary scoped to correct chain', async () => {
    insertSweep('tron', 'tron:TRX', 'pending_signature');

    const btcRes = await request(app)
      .get('/v1/sweeps/summary?chainId=bitcoin')
      .set(AUTH);
    const tronRes = await request(app)
      .get('/v1/sweeps/summary?chainId=tron&assetId=tron:TRX')
      .set(AUTH);

    // BTC summary should not leak TRON pending sweep
    if (btcRes.body.data.pending_sweep_id) {
      const pendingSweep = btcRes.body.data.pending_sweep_id;
      const sweepRes = await request(app)
        .get(`/v1/sweeps/${pendingSweep}`)
        .set(AUTH);
      expect(sweepRes.body.data?.chain_id).toBe('bitcoin');
    }
    // TRON summary sees the TRON pending sweep
    expect(tronRes.body.data.pending_sweep_id).toBeTruthy();
  });
});
