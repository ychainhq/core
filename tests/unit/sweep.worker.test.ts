/**
 * Unit tests for SweepWorker.
 *
 * Covered:
 * - Uses createUnsignedPsbt (not walletCreateFundedPsbt) — regression for "Not solvable" RPC -4
 * - Fee is taken directly from estimateSmartFee.feeRate (no ×100000 bug)
 * - Fee vbytes formula: 42 + 68 × N_inputs (P2WPKH)
 * - Dust threshold guard (output ≤ 546 sats → skip)
 * - Threshold check (totalSats < threshold → skip)
 * - Deduplication (existing pending_signature sweep → skip)
 * - Sweep record written with correct amounts
 * - Idempotency (second run skips because sweep is pending_signature)
 *
 * v3: UTXOs come from cached_utxos table (populated by DepositEventProcessorWorker),
 *     NOT from Bitcoin Core listunspent / getUtxosForAddress.
 */

import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { closeDb, getDb } from '../../src/db/sqlite';
import { resetDbClient } from '../../src/db/client';
import { BitcoinAdapter } from '../../src/chain-adapters/bitcoin/adapter';
import { adapterRegistry } from '../../src/chain-adapters/registry';
import { SweepWorker } from '../../src/workers/sweep.worker';

jest.mock('../../src/chain-adapters/bitcoin/adapter');

const TENANT_ID = 'tenant_default';
const DEPOSIT_ADDRESS = 'bcrt1q0000000000000000000000000000000000000qk6ng7';
const FAKE_PSBT = 'cHNidP8BAAoAAAAA==';

const VBYTES_1_INPUT = 42 + 68;       // 110
const VBYTES_3_INPUTS = 42 + 68 * 3;  // 246

type MockAdapter = {
  chain: string;
  estimateSmartFee: jest.Mock;
  createUnsignedPsbt: jest.Mock;
  walletCreateFundedPsbt: jest.Mock;
  isValidAddress: jest.Mock;
  provisionTenantWallet: jest.Mock;
  importAddressForTenant: jest.Mock;
  batchImportAddresses: jest.Mock;
  getBlockCount: jest.Mock;
  getAddressBalance: jest.Mock;
  getWalletUtxos: jest.Mock;
  getUtxosForAddress: jest.Mock; // kept for mock type completeness; NOT called in v3
  [key: string]: any;
};

let mockAdapter: MockAdapter;
let depositWalletId: string; // set by bootstrap(), used by insertUtxo()

beforeAll(() => {
  mockAdapter = {
    chain: 'bitcoin',
    estimateSmartFee: jest.fn().mockResolvedValue({ feeRate: 5, targetBlocks: 6, mode: 'conservative' }),
    createUnsignedPsbt: jest.fn().mockResolvedValue(FAKE_PSBT),
    walletCreateFundedPsbt: jest.fn(),
    isValidAddress: jest.fn().mockReturnValue(true),
    provisionTenantWallet: jest.fn().mockResolvedValue(undefined),
    importAddressForTenant: jest.fn().mockResolvedValue(undefined),
    batchImportAddresses: jest.fn().mockResolvedValue(undefined),
    getBlockCount: jest.fn().mockResolvedValue(1000),
    getAddressBalance: jest.fn().mockResolvedValue({ confirmed: '0', unconfirmed: '0', total: '0' }),
    getWalletUtxos: jest.fn().mockResolvedValue([]),
    getUtxosForAddress: jest.fn().mockResolvedValue([]), // should NOT be called in v3
  };
  (BitcoinAdapter as jest.MockedClass<typeof BitcoinAdapter>).mockImplementation(() => mockAdapter as any);
});

afterEach(() => { closeDb(); resetDbClient(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

let _utxoSeq = 0;

/**
 * Insert a row into cached_utxos (v3 UTXO source).
 * Replaces adapter.getUtxosForAddress mock — SweepWorker now reads from DB.
 */
function insertUtxo(txHash: string, vout = 0, amountSats = 500_000, confirmations = 2) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO cached_utxos
      (id, tenant_id, customer_id, wallet_id, wallet_role, chain_id,
       address, tx_hash, vout, amount_raw, confirmations, is_spent, is_locked, created_at, updated_at)
    VALUES (?, ?, NULL, ?, 'customer_deposits', 'bitcoin', ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    `utxo_test_${++_utxoSeq}`,
    TENANT_ID, depositWalletId, DEPOSIT_ADDRESS,
    txHash, vout, String(amountSats), confirmations, now, now
  );
}

async function bootstrap({ thresholdSats = '100000' }: { thresholdSats?: string } = {}) {
  closeDb();
  resetDbClient();
  _utxoSeq = 0;
  await runMigrations();
  adapterRegistry.register(mockAdapter as any);
  await runSeed();

  const db = getDb();
  const now = new Date().toISOString();

  db.prepare('UPDATE tenant_configs SET btc_sweep_threshold_sats = ? WHERE tenant_id = ?')
    .run(thresholdSats, TENANT_ID);

  const depositWallet = db.prepare(
    "SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits' LIMIT 1"
  ).get(TENANT_ID) as { id: string } | undefined;
  if (!depositWallet) throw new Error('seed did not create a customer_deposits wallet for tenant_default');

  depositWalletId = depositWallet.id;

  db.prepare(`
    INSERT INTO addresses
      (id, tenant_id, customer_id, wallet_id, chain_id, address, label,
       address_type, status, address_role, metadata, created_at, updated_at)
    VALUES (?, ?, NULL, ?, 'bitcoin', ?, NULL, 'p2wpkh', 'active', 'customer_deposit', NULL, ?, ?)
  `).run('addr_dep_sw_test', TENANT_ID, depositWalletId, DEPOSIT_ADDRESS, now, now);

  mockAdapter.estimateSmartFee.mockReset().mockResolvedValue({ feeRate: 5, targetBlocks: 6, mode: 'conservative' });
  mockAdapter.createUnsignedPsbt.mockReset().mockResolvedValue(FAKE_PSBT);
  mockAdapter.walletCreateFundedPsbt.mockReset();
  mockAdapter.getUtxosForAddress.mockReset().mockResolvedValue([]);
}

function getHotAddress(): string {
  const row = getDb().prepare(`
    SELECT a.address FROM addresses a
    JOIN wallets w ON w.id = a.wallet_id
    WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
      AND a.chain_id = 'bitcoin' AND a.status = 'active'
    LIMIT 1
  `).get(TENANT_ID) as { address: string } | undefined;
  if (!row) throw new Error('no tenant_hot address in DB');
  return row.address;
}

function sweepCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM sweeps').get() as { n: number }).n;
}

function getOnlySweep(): any {
  return getDb().prepare('SELECT * FROM sweeps LIMIT 1').get();
}

function capturedOutputBtc(): number {
  const [, outputs] = mockAdapter.createUnsignedPsbt.mock.calls[0];
  return Object.values(outputs[0])[0] as number;
}

// ── v3 compliance ─────────────────────────────────────────────────────────────

describe('v3: UTXOs come from cached_utxos, not from Bitcoin Core', () => {
  it('does NOT call getUtxosForAddress (listunspent) — uses cached_utxos instead', async () => {
    await bootstrap();
    insertUtxo('tx_v3_check');

    await new SweepWorker().run();

    expect(mockAdapter.getUtxosForAddress).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(1);
  });

  it('skips when cached_utxos is empty even though deposit addresses exist', async () => {
    await bootstrap();
    // No insertUtxo call — DB has deposit address but no cached UTXOs

    await new SweepWorker().run();

    expect(mockAdapter.createUnsignedPsbt).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(0);
  });
});

// ── PSBT creation method ──────────────────────────────────────────────────────

describe('PSBT creation uses createUnsignedPsbt, not walletCreateFundedPsbt', () => {
  it('calls createUnsignedPsbt (regression: addr() descriptors are not solvable for walletCreateFundedPsbt)', async () => {
    await bootstrap();
    insertUtxo('tx_rg01');

    await new SweepWorker().run();

    expect(mockAdapter.createUnsignedPsbt).toHaveBeenCalledTimes(1);
    expect(mockAdapter.walletCreateFundedPsbt).not.toHaveBeenCalled();
  });

  it('passes correct inputs array { txid, vout } to createUnsignedPsbt', async () => {
    await bootstrap();
    insertUtxo('deadbeef', 2);

    await new SweepWorker().run();

    const [inputs] = mockAdapter.createUnsignedPsbt.mock.calls[0];
    expect(inputs).toEqual([{ txid: 'deadbeef', vout: 2 }]);
  });

  it('passes hot-address as the sole output key to createUnsignedPsbt', async () => {
    await bootstrap();
    insertUtxo('tx_out01', 0, 500_000);
    mockAdapter.estimateSmartFee.mockResolvedValue({ feeRate: 0, targetBlocks: 6, mode: 'conservative' });

    await new SweepWorker().run();

    const [, outputs] = mockAdapter.createUnsignedPsbt.mock.calls[0];
    const hotAddress = getHotAddress();
    expect(outputs[0]).toHaveProperty(hotAddress);
  });
});

// ── Fee calculation ───────────────────────────────────────────────────────────

describe('Fee calculation', () => {
  it('uses feeRate from estimateSmartFee directly (regression: old code multiplied by 100000)', async () => {
    await bootstrap();
    mockAdapter.estimateSmartFee.mockResolvedValue({ feeRate: 10, targetBlocks: 6, mode: 'conservative' });
    insertUtxo('tx_reg_fee01', 0, 500_000);

    await new SweepWorker().run();

    expect(sweepCount()).toBe(1);
  });

  it('deducts feeRate × (42 + 68 × 1) sats for a single P2WPKH input', async () => {
    await bootstrap();
    mockAdapter.estimateSmartFee.mockResolvedValue({ feeRate: 10, targetBlocks: 6, mode: 'conservative' });
    insertUtxo('tx_fee1in', 0, 500_000);

    await new SweepWorker().run();

    const expectedSats = 500_000 - 10 * VBYTES_1_INPUT; // 498 900
    expect(capturedOutputBtc()).toBeCloseTo(expectedSats / 1e8, 7);
  });

  it('scales fee with number of inputs: 3 inputs → fee = feeRate × (42 + 68 × 3)', async () => {
    await bootstrap({ thresholdSats: '10000' });
    mockAdapter.estimateSmartFee.mockResolvedValue({ feeRate: 2, targetBlocks: 6, mode: 'conservative' });
    insertUtxo('tx_3in_a', 0, 50_000);
    insertUtxo('tx_3in_b', 1, 50_000);
    insertUtxo('tx_3in_c', 2, 50_000);

    await new SweepWorker().run();

    const expectedSats = 150_000 - 2 * VBYTES_3_INPUTS; // 149 508
    expect(capturedOutputBtc()).toBeCloseTo(expectedSats / 1e8, 7);
  });

  it('stores fee_raw = feeRate × vbytes in the sweep record', async () => {
    await bootstrap();
    mockAdapter.estimateSmartFee.mockResolvedValue({ feeRate: 10, targetBlocks: 6, mode: 'conservative' });
    insertUtxo('tx_feerec01', 0, 500_000);

    await new SweepWorker().run();

    expect(getOnlySweep().fee_raw).toBe(String(10 * VBYTES_1_INPUT)); // '1100'
  });

  it('falls back to 5 sat/vB when estimateSmartFee throws', async () => {
    await bootstrap();
    mockAdapter.estimateSmartFee.mockRejectedValue(new Error('estimatesmartfee not available'));
    insertUtxo('tx_fallback01', 0, 500_000);

    await new SweepWorker().run();

    const expectedSats = 500_000 - 5 * VBYTES_1_INPUT; // 499 450
    expect(capturedOutputBtc()).toBeCloseTo(expectedSats / 1e8, 7);
  });
});

// ── Dust threshold ────────────────────────────────────────────────────────────

describe('Dust threshold guard (output ≤ 546 sats)', () => {
  it('skips when fee consumes enough that output ≤ 546 sats', async () => {
    await bootstrap({ thresholdSats: '100' });
    mockAdapter.estimateSmartFee.mockResolvedValue({ feeRate: 5, targetBlocks: 6, mode: 'conservative' });
    insertUtxo('tx_dust01', 0, 1_000);

    await new SweepWorker().run();

    expect(mockAdapter.createUnsignedPsbt).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(0);
  });

  it('proceeds when output after fee is above 546 sats', async () => {
    await bootstrap({ thresholdSats: '100' });
    mockAdapter.estimateSmartFee.mockResolvedValue({ feeRate: 1, targetBlocks: 6, mode: 'conservative' });
    insertUtxo('tx_nodust01', 0, 1_000);

    await new SweepWorker().run();

    expect(mockAdapter.createUnsignedPsbt).toHaveBeenCalledTimes(1);
  });
});

// ── Pre-condition checks ──────────────────────────────────────────────────────

describe('Pre-condition checks', () => {
  it('skips when totalSats < threshold', async () => {
    await bootstrap({ thresholdSats: '500000' });
    insertUtxo('tx_below01', 0, 100_000);

    await new SweepWorker().run();

    expect(mockAdapter.createUnsignedPsbt).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(0);
  });

  it('skips when there are no deposit UTXOs in cached_utxos', async () => {
    await bootstrap();
    // No insertUtxo — cached_utxos is empty

    await new SweepWorker().run();

    expect(mockAdapter.createUnsignedPsbt).not.toHaveBeenCalled();
  });

  it('skips when an existing pending_signature sweep already exists', async () => {
    await bootstrap();
    const db = getDb();
    const now = new Date().toISOString();
    const hotAddress = getHotAddress();
    db.prepare(`
      INSERT INTO sweeps
        (id, tenant_id, chain_id, asset_id, status,
         from_addresses, to_address, amount_raw, fee_raw, psbt,
         created_at, updated_at)
      VALUES ('sweep_existing_01', ?, 'bitcoin', 'bitcoin:BTC', 'pending_signature',
              '[]', ?, '500000', '550', 'fake==', ?, ?)
    `).run(TENANT_ID, hotAddress, now, now);

    insertUtxo('tx_dup01', 0, 500_000);

    await new SweepWorker().run();

    expect(mockAdapter.createUnsignedPsbt).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(1); // only the pre-inserted one
  });

  it('skips when no tenant has btc_sweep_threshold_sats set', async () => {
    closeDb();
    resetDbClient();
    await runMigrations();
    adapterRegistry.register(mockAdapter as any);
    await runSeed();
    // btc_sweep_threshold_sats deliberately left as NULL (seed default)

    await new SweepWorker().run();

    expect(mockAdapter.getUtxosForAddress).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(0);
  });
});

// ── Sweep record creation ─────────────────────────────────────────────────────

describe('Sweep record creation', () => {
  it('creates a sweep with status pending_signature', async () => {
    await bootstrap();
    insertUtxo('tx_record01', 0, 500_000);

    await new SweepWorker().run();

    expect(sweepCount()).toBe(1);
    const sweep = getOnlySweep();
    expect(sweep.status).toBe('pending_signature');
    expect(sweep.tenant_id).toBe(TENANT_ID);
    expect(sweep.chain_id).toBe('bitcoin');
  });

  it('stores to_address = the tenant hot wallet address', async () => {
    await bootstrap();
    insertUtxo('tx_toaddr01', 0, 500_000);

    await new SweepWorker().run();

    expect(getOnlySweep().to_address).toBe(getHotAddress());
  });

  it('stores the PSBT returned by createUnsignedPsbt', async () => {
    await bootstrap();
    insertUtxo('tx_psbt01', 0, 500_000);

    await new SweepWorker().run();

    expect(getOnlySweep().psbt).toBe(FAKE_PSBT);
  });

  it('stores amount_raw = total UTXO input sats (before fee deduction)', async () => {
    await bootstrap();
    insertUtxo('tx_amt01', 0, 500_000);

    await new SweepWorker().run();

    expect(getOnlySweep().amount_raw).toBe('500000');
  });

  it('is idempotent: second run skips because sweep is already pending_signature', async () => {
    await bootstrap();
    insertUtxo('tx_idem01', 0, 500_000);

    const worker = new SweepWorker();
    await worker.run();
    await worker.run();

    expect(sweepCount()).toBe(1);
    expect(mockAdapter.createUnsignedPsbt).toHaveBeenCalledTimes(1);
  });
});
