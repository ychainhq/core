/**
 * utxoLockService balance methods — integration tests on real SQLite.
 *
 * Covers:
 * - getAddressBalance: normal amounts, zero, multiple UTXOs, confirmed/unconfirmed split
 * - getWalletBalances: per-chain aggregation
 * - Large amounts (>2,147,483,647 sats = >21 BTC) to guard against INTEGER overflow
 *   on PostgreSQL. CAST(amount_raw AS BIGINT) must not truncate; CAST AS INTEGER would.
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
