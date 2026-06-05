/**
 * utxoLockService — integration tests on real SQLite.
 *
 * Covers:
 * - getAddressBalance: normal amounts, zero, multiple UTXOs, confirmed/unconfirmed split
 * - getWalletBalances: per-chain aggregation
 * - Large amounts (>2,147,483,647 sats = >21 BTC) to guard against INTEGER overflow
 *   on PostgreSQL. CAST(amount_raw AS BIGINT) must not truncate; CAST AS INTEGER would.
 * - lockUtxosForSweep: atomic lock, rollback on conflict, rollback on spent UTXO
 * - releaseLocksForSweep: unlocks cached_utxos, marks utxo_locks as released, idempotent
 * - markSpentForSweep: marks cached_utxos spent + utxo_locks status=spent, idempotent
 * - getLockedForBatch: returns only locked UTXOs for the given batch
 *
 * WHY: both SQLite and PostgreSQL code paths are exercised here (SQLite in tests,
 * PostgreSQL in production). BIGINT in SQLite = INTEGER affinity = 64-bit, same
 * semantics as PostgreSQL BIGINT. Any regression to CAST AS INTEGER would fail the
 * large-amount assertions below (5,000,000,000 > 2,147,483,647 = overflow).
 */

import { getDb } from '../../src/db/sqlite';
import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { utxoLockService } from '../../src/shared/utxo-lock/utxo-lock.service';
import { resetDbClient } from '../../src/db/client';
import { closeDb } from '../../src/db/sqlite';

const TENANT  = 'tenant_default';
const CHAIN   = 'bitcoin';
const ADDR_A  = 'bc1qtest_addr_a_0000000000000000000qk6ng7';
const ADDR_B  = 'bc1qtest_addr_b_0000000000000000000qk6ng7';
let WALLET = '';

let utxoSeq = 0;
function insertUtxo(opts: {
  address: string;
  txHash?: string;
  vout?: number;
  amountRaw: string;
  confirmations?: number;
  isSpent?: number;
  walletId?: string;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = `utxo_test_${++utxoSeq}`;
  db.prepare(`
    INSERT OR IGNORE INTO cached_utxos
      (id, tenant_id, customer_id, wallet_id, wallet_role, chain_id,
       address, tx_hash, vout, amount_raw, confirmations, is_spent, is_locked, created_at, updated_at)
    VALUES (?, ?, NULL, ?, 'customer_deposits', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id, TENANT, opts.walletId ?? WALLET, CHAIN,
    opts.address, opts.txHash ?? `txhash_${id}`, opts.vout ?? 0,
    opts.amountRaw, opts.confirmations ?? 6,
    opts.isSpent ?? 0, now, now
  );
}

beforeAll(async () => {
  closeDb();
  resetDbClient();
  await runMigrations();
  await runSeed();
  // Use the customer_deposits wallet created by seed (satisfies FK constraint on cached_utxos)
  const row = getDb().prepare(
    "SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits' LIMIT 1"
  ).get(TENANT) as { id: string } | undefined;
  if (!row) throw new Error('seed did not create customer_deposits wallet for tenant_default');
  WALLET = row.id;
});
afterAll(() => { closeDb(); resetDbClient(); });
afterEach(() => {
  getDb().prepare('DELETE FROM cached_utxos WHERE id LIKE ?').run('utxo_test_%');
  // Clean up any utxo_locks created by sweep/batch lock tests
  getDb().prepare("DELETE FROM utxo_locks WHERE reference_id LIKE 'sweep_test_%'").run();
  getDb().prepare("DELETE FROM utxo_locks WHERE reference_id LIKE 'batch_test_%'").run();
});

// ─── getAddressBalance ────────────────────────────────────────────────────────

describe('utxoLockService.getAddressBalance', () => {
  test('returns zero when no UTXOs exist', async () => {
    const bal = await utxoLockService.getAddressBalance(TENANT, CHAIN, ADDR_A);
    expect(bal).toEqual({ confirmed: '0', unconfirmed: '0', total: '0' });
  });

  test('single confirmed UTXO', async () => {
    insertUtxo({ address: ADDR_A, amountRaw: '100000', confirmations: 3 });
    const bal = await utxoLockService.getAddressBalance(TENANT, CHAIN, ADDR_A);
    expect(bal.confirmed).toBe('100000');
    expect(bal.unconfirmed).toBe('0');
    expect(bal.total).toBe('100000');
  });

  test('single unconfirmed UTXO (confirmations = 0)', async () => {
    insertUtxo({ address: ADDR_A, amountRaw: '50000', confirmations: 0 });
    const bal = await utxoLockService.getAddressBalance(TENANT, CHAIN, ADDR_A);
    expect(bal.confirmed).toBe('0');
    expect(bal.unconfirmed).toBe('50000');
    expect(bal.total).toBe('50000');
  });

  test('sums confirmed and unconfirmed separately across multiple UTXOs', async () => {
    insertUtxo({ address: ADDR_A, amountRaw: '100000', confirmations: 6 });
    insertUtxo({ address: ADDR_A, amountRaw: '200000', confirmations: 1 });
    insertUtxo({ address: ADDR_A, amountRaw: '30000',  confirmations: 0 });
    const bal = await utxoLockService.getAddressBalance(TENANT, CHAIN, ADDR_A);
    expect(bal.confirmed).toBe('300000');   // 100k + 200k
    expect(bal.unconfirmed).toBe('30000');
    expect(bal.total).toBe('330000');
  });

  test('excludes is_spent=1 UTXOs', async () => {
    insertUtxo({ address: ADDR_A, amountRaw: '500000', confirmations: 6, isSpent: 0 });
    insertUtxo({ address: ADDR_A, amountRaw: '999999', confirmations: 6, isSpent: 1 });
    const bal = await utxoLockService.getAddressBalance(TENANT, CHAIN, ADDR_A);
    expect(bal.confirmed).toBe('500000');
  });

  test('does not include UTXOs from a different address', async () => {
    insertUtxo({ address: ADDR_A, amountRaw: '111111', confirmations: 6 });
    insertUtxo({ address: ADDR_B, amountRaw: '999999', confirmations: 6 });
    const bal = await utxoLockService.getAddressBalance(TENANT, CHAIN, ADDR_A);
    expect(bal.confirmed).toBe('111111');
  });

  // ── Large-amount guard: BIGINT vs INTEGER overflow ───────────────────────
  // PostgreSQL INTEGER max = 2,147,483,647 (~21.47 BTC).
  // A single coinbase block reward in regtest = 50 BTC = 5,000,000,000 sats.
  // CAST(amount_raw AS INTEGER) would silently overflow on PostgreSQL.
  // CAST(amount_raw AS BIGINT) handles it correctly in both SQLite and PostgreSQL.

  test('handles single UTXO of 50 BTC (5,000,000,000 sats) without overflow', async () => {
    const fiftyBtc = '5000000000'; // > 2,147,483,647 (PostgreSQL INTEGER max)
    insertUtxo({ address: ADDR_A, amountRaw: fiftyBtc, confirmations: 6 });
    const bal = await utxoLockService.getAddressBalance(TENANT, CHAIN, ADDR_A);
    expect(bal.confirmed).toBe(fiftyBtc);
    expect(bal.total).toBe(fiftyBtc);
  });

  test('sums multiple large UTXOs correctly (would overflow INTEGER but not BIGINT)', async () => {
    // 3 × 50 BTC = 150 BTC = 15,000,000,000 sats (>> INTEGER max)
    insertUtxo({ address: ADDR_A, amountRaw: '5000000000', confirmations: 6 });
    insertUtxo({ address: ADDR_A, amountRaw: '5000000000', confirmations: 6, vout: 1 });
    insertUtxo({ address: ADDR_A, amountRaw: '5000000000', confirmations: 6, vout: 2 });
    const bal = await utxoLockService.getAddressBalance(TENANT, CHAIN, ADDR_A);
    expect(bal.confirmed).toBe('15000000000');
  });

  test('handles coinbase + sweep mix: large confirmed + small unconfirmed', async () => {
    insertUtxo({ address: ADDR_A, amountRaw: '5000000000', confirmations: 6 });
    insertUtxo({ address: ADDR_A, amountRaw: '299644',     confirmations: 0 });
    const bal = await utxoLockService.getAddressBalance(TENANT, CHAIN, ADDR_A);
    expect(bal.confirmed).toBe('5000000000');
    expect(bal.unconfirmed).toBe('299644');
    expect(bal.total).toBe('5000299644');
  });
});

// ─── getWalletBalances ────────────────────────────────────────────────────────

describe('utxoLockService.getWalletBalances', () => {
  test('returns empty object when wallet has no UTXOs', async () => {
    const bals = await utxoLockService.getWalletBalances(WALLET);
    expect(bals).toEqual({});
  });

  test('aggregates by chain_id', async () => {
    insertUtxo({ address: ADDR_A, amountRaw: '100000', confirmations: 6 });
    insertUtxo({ address: ADDR_A, amountRaw: '200000', confirmations: 6, vout: 1 });
    const bals = await utxoLockService.getWalletBalances(WALLET);
    expect(bals[CHAIN]?.confirmed).toBe('300000');
    expect(bals[CHAIN]?.unconfirmed).toBe('0');
    expect(bals[CHAIN]?.total).toBe('300000');
  });

  test('large wallet balance without INTEGER overflow', async () => {
    // hot wallet after receiving coinbase: 50 BTC per block
    insertUtxo({ address: ADDR_A, amountRaw: '5000000000', confirmations: 100 });
    insertUtxo({ address: ADDR_A, amountRaw: '5000000000', confirmations: 50, vout: 1 });
    const bals = await utxoLockService.getWalletBalances(WALLET);
    expect(bals[CHAIN]?.confirmed).toBe('10000000000');
    expect(bals[CHAIN]?.total).toBe('10000000000');
  });

  test('excludes spent UTXOs from wallet balance', async () => {
    insertUtxo({ address: ADDR_A, amountRaw: '500000',   isSpent: 0 });
    insertUtxo({ address: ADDR_A, amountRaw: '5000000000', isSpent: 1, vout: 1 });
    const bals = await utxoLockService.getWalletBalances(WALLET);
    expect(bals[CHAIN]?.confirmed).toBe('500000');
  });
});

// ─── lockUtxosForSweep ────────────────────────────────────────────────────────

describe('utxoLockService.lockUtxosForSweep', () => {
  const SWEEP_ID = 'sweep_test_lock_001';
  const TX_A = 'aabbcc0000000000000000000000000a';
  const TX_B = 'aabbcc0000000000000000000000000b';

  test('sets is_locked=1 on cached_utxos and creates utxo_locks records with reference_type=sweep', async () => {
    insertUtxo({ address: ADDR_A, txHash: TX_A, vout: 0, amountRaw: '100000' });
    insertUtxo({ address: ADDR_A, txHash: TX_B, vout: 0, amountRaw: '75000' });

    await utxoLockService.lockUtxosForSweep(TENANT, SWEEP_ID, CHAIN, [
      { tx_hash: TX_A, vout: 0, amount_raw: '100000' },
      { tx_hash: TX_B, vout: 0, amount_raw: '75000' },
    ]);

    const db = getDb();
    const utxoA = db.prepare('SELECT is_locked FROM cached_utxos WHERE tx_hash = ? AND vout = 0').get(TX_A) as any;
    const utxoB = db.prepare('SELECT is_locked FROM cached_utxos WHERE tx_hash = ? AND vout = 0').get(TX_B) as any;
    expect(utxoA.is_locked).toBe(1);
    expect(utxoB.is_locked).toBe(1);

    const locks = db.prepare(
      "SELECT reference_id, reference_type, status FROM utxo_locks WHERE reference_id = ?"
    ).all(SWEEP_ID) as any[];
    expect(locks).toHaveLength(2);
    expect(locks.every((l: any) => l.reference_type === 'sweep')).toBe(true);
    expect(locks.every((l: any) => l.status === 'locked')).toBe(true);
  });

  test('throws and rolls back if a UTXO is already locked — no utxo_locks records created', async () => {
    insertUtxo({ address: ADDR_A, txHash: TX_A, vout: 0, amountRaw: '100000' });
    // manually lock it before the sweep worker gets there
    getDb().prepare('UPDATE cached_utxos SET is_locked = 1 WHERE tx_hash = ? AND vout = 0').run(TX_A);

    await expect(
      utxoLockService.lockUtxosForSweep(TENANT, SWEEP_ID, CHAIN, [
        { tx_hash: TX_A, vout: 0, amount_raw: '100000' },
      ])
    ).rejects.toThrow('no longer available');

    const locks = getDb().prepare(
      "SELECT * FROM utxo_locks WHERE reference_id = ? AND reference_type = 'sweep'"
    ).all(SWEEP_ID) as any[];
    expect(locks).toHaveLength(0);
  });

  test('throws and rolls back if a UTXO is already spent', async () => {
    insertUtxo({ address: ADDR_A, txHash: TX_A, vout: 0, amountRaw: '100000', isSpent: 1 });

    await expect(
      utxoLockService.lockUtxosForSweep(TENANT, SWEEP_ID, CHAIN, [
        { tx_hash: TX_A, vout: 0, amount_raw: '100000' },
      ])
    ).rejects.toThrow('no longer available');

    const locks = getDb().prepare(
      "SELECT * FROM utxo_locks WHERE reference_id = ? AND reference_type = 'sweep'"
    ).all(SWEEP_ID) as any[];
    expect(locks).toHaveLength(0);
  });
});

// ─── releaseLocksForSweep ─────────────────────────────────────────────────────

describe('utxoLockService.releaseLocksForSweep', () => {
  const SWEEP_ID = 'sweep_test_release_001';
  const TX_A = 'cc000000000000000000000000000001';

  test('sets is_locked=0 and utxo_locks.status=released with released_at', async () => {
    insertUtxo({ address: ADDR_A, txHash: TX_A, vout: 0, amountRaw: '100000' });
    await utxoLockService.lockUtxosForSweep(TENANT, SWEEP_ID, CHAIN, [
      { tx_hash: TX_A, vout: 0, amount_raw: '100000' },
    ]);

    await utxoLockService.releaseLocksForSweep(TENANT, SWEEP_ID);

    const db = getDb();
    const utxo = db.prepare('SELECT is_locked FROM cached_utxos WHERE tx_hash = ? AND vout = 0').get(TX_A) as any;
    expect(utxo.is_locked).toBe(0);

    const lock = db.prepare(
      "SELECT status, released_at FROM utxo_locks WHERE reference_id = ? AND reference_type = 'sweep'"
    ).get(SWEEP_ID) as any;
    expect(lock.status).toBe('released');
    expect(lock.released_at).not.toBeNull();
  });

  test('is idempotent — second call does not throw', async () => {
    insertUtxo({ address: ADDR_A, txHash: TX_A, vout: 0, amountRaw: '100000' });
    await utxoLockService.lockUtxosForSweep(TENANT, SWEEP_ID, CHAIN, [
      { tx_hash: TX_A, vout: 0, amount_raw: '100000' },
    ]);

    await utxoLockService.releaseLocksForSweep(TENANT, SWEEP_ID);
    await expect(utxoLockService.releaseLocksForSweep(TENANT, SWEEP_ID)).resolves.toBeUndefined();
  });
});

// ─── markSpentForSweep ────────────────────────────────────────────────────────

describe('utxoLockService.markSpentForSweep', () => {
  const SWEEP_ID = 'sweep_test_spent_001';
  const TX_A = 'dd000000000000000000000000000001';

  test('sets is_spent=1, is_locked=0 and utxo_locks.status=spent', async () => {
    insertUtxo({ address: ADDR_A, txHash: TX_A, vout: 0, amountRaw: '100000' });
    await utxoLockService.lockUtxosForSweep(TENANT, SWEEP_ID, CHAIN, [
      { tx_hash: TX_A, vout: 0, amount_raw: '100000' },
    ]);

    await utxoLockService.markSpentForSweep(TENANT, SWEEP_ID);

    const db = getDb();
    const utxo = db.prepare(
      'SELECT is_spent, is_locked FROM cached_utxos WHERE tx_hash = ? AND vout = 0'
    ).get(TX_A) as any;
    expect(utxo.is_spent).toBe(1);
    expect(utxo.is_locked).toBe(0);

    const lock = db.prepare(
      "SELECT status FROM utxo_locks WHERE reference_id = ? AND reference_type = 'sweep'"
    ).get(SWEEP_ID) as any;
    expect(lock.status).toBe('spent');
  });

  test('is idempotent when btc-indexer already marked is_spent=1', async () => {
    insertUtxo({ address: ADDR_A, txHash: TX_A, vout: 0, amountRaw: '100000' });
    await utxoLockService.lockUtxosForSweep(TENANT, SWEEP_ID, CHAIN, [
      { tx_hash: TX_A, vout: 0, amount_raw: '100000' },
    ]);
    // Simulate btc-indexer racing ahead
    getDb().prepare(
      'UPDATE cached_utxos SET is_spent = 1, is_locked = 0 WHERE tx_hash = ? AND vout = 0'
    ).run(TX_A);

    await expect(utxoLockService.markSpentForSweep(TENANT, SWEEP_ID)).resolves.toBeUndefined();
  });
});

// ─── getLockedForBatch ────────────────────────────────────────────────────────

describe('utxoLockService.getLockedForBatch', () => {
  const BATCH_A = 'batch_test_get_001';
  const BATCH_B = 'batch_test_get_002';
  const SWEEP_X = 'sweep_test_get_001';

  function insertLock(opts: {
    referenceId: string;
    referenceType: 'batch' | 'sweep';
    txHash: string;
    vout: number;
    amountRaw: string;
    status?: string;
  }) {
    const db = getDb();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    db.prepare(`
      INSERT INTO utxo_locks
        (id, tenant_id, reference_id, reference_type, chain_id, tx_hash, vout, amount_raw, status, locked_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `ulk_test_${opts.txHash}_${opts.vout}`,
      TENANT, opts.referenceId, opts.referenceType,
      CHAIN, opts.txHash, opts.vout, opts.amountRaw,
      opts.status ?? 'locked', now, expiresAt,
    );
  }

  afterEach(() => {
    getDb().prepare("DELETE FROM utxo_locks WHERE id LIKE 'ulk_test_%'").run();
  });

  test('returns locked UTXOs for the given batch', async () => {
    insertLock({ referenceId: BATCH_A, referenceType: 'batch', txHash: 'ee0001', vout: 0, amountRaw: '50000' });
    insertLock({ referenceId: BATCH_A, referenceType: 'batch', txHash: 'ee0002', vout: 0, amountRaw: '30000' });

    const result = await utxoLockService.getLockedForBatch(TENANT, BATCH_A);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.tx_hash).sort()).toEqual(['ee0001', 'ee0002'].sort());
  });

  test('does not return UTXOs from a different batch', async () => {
    insertLock({ referenceId: BATCH_A, referenceType: 'batch', txHash: 'ee0003', vout: 0, amountRaw: '50000' });
    insertLock({ referenceId: BATCH_B, referenceType: 'batch', txHash: 'ee0004', vout: 0, amountRaw: '20000' });

    const result = await utxoLockService.getLockedForBatch(TENANT, BATCH_A);
    expect(result).toHaveLength(1);
    expect(result[0]!.tx_hash).toBe('ee0003');
  });

  test('does not return sweep-type locks even if reference_id matches', async () => {
    insertLock({ referenceId: BATCH_A, referenceType: 'sweep', txHash: 'ee0005', vout: 0, amountRaw: '10000' });

    const result = await utxoLockService.getLockedForBatch(TENANT, BATCH_A);
    expect(result).toHaveLength(0);
  });

  test('does not return released locks', async () => {
    insertLock({ referenceId: BATCH_A, referenceType: 'batch', txHash: 'ee0006', vout: 0, amountRaw: '10000', status: 'released' });

    const result = await utxoLockService.getLockedForBatch(TENANT, BATCH_A);
    expect(result).toHaveLength(0);
  });

  test('returns empty array when no locked UTXOs exist for batch', async () => {
    const result = await utxoLockService.getLockedForBatch(TENANT, SWEEP_X);
    expect(result).toHaveLength(0);
  });
});
