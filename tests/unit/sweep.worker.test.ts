/**
 * Unit tests for SweepWorker.
 *
 * Covered:
 * - Uses buildSweepPsbt (not walletCreateFundedPsbt) — regression for "Not solvable" RPC -4
 * - Fee rate from estimateFeeRateSatVb (adapter method with cache+fallback)
 * - Vsize via estimateTxVsize from tx-sizer (ceil(10.5 + 68×N + 31×1) for P2WPKH sweep)
 * - btc_fee_target_blocks from tenant_configs passed to estimateFeeRateSatVb
 * - Dust threshold guard (output ≤ 546 sats → skip)
 * - Threshold check (totalSats < threshold → skip)
 * - Deduplication (existing pending_signature sweep → skip)
 * - Sweep record written with correct amounts
 * - Idempotency (second run skips because sweep is pending_signature)
 * - PSBT enrichment: enriched PSBT stored; enrichment failure is non-fatal
 * - Recovery: orphaned sweep (no signing_task_id) → signing task created
 * - Recovery: expired/failed signing task → task recreated
 *
 * v3: UTXOs come from cached_utxos table (populated by DepositEventProcessorWorker),
 *     NOT from Bitcoin Core listunspent / getUtxosForAddress.
 */

// Preserve exported constants (DUST_THRESHOLD_SATS) — only mock the class itself.
jest.mock('../../src/chain-adapters/bitcoin/adapter', () => {
  const actual = jest.requireActual('../../src/chain-adapters/bitcoin/adapter');
  return { ...actual, BitcoinAdapter: jest.fn() };
});
jest.mock('../../src/chain-adapters/bitcoin/psbt-enricher');

import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { closeDb, getDb } from '../../src/db/sqlite';
import { resetDbClient } from '../../src/db/client';
import { BitcoinAdapter } from '../../src/chain-adapters/bitcoin/adapter';
import { enrichSweepPsbt } from '../../src/chain-adapters/bitcoin/psbt-enricher';
import { adapterRegistry } from '../../src/chain-adapters/registry';
import { SweepWorker } from '../../src/workers/sweep.worker';
import { sweepsService } from '../../src/modules/sweeps/sweeps.service';
import { signingTasksService } from '../../src/modules/signing-tasks/signing-tasks.service';
import { utxoLockService } from '../../src/shared/utxo-lock/utxo-lock.service';

const TENANT_ID = 'tenant_default';
const DEPOSIT_ADDRESS = 'bcrt1q0000000000000000000000000000000000000qk6ng7';
const FAKE_PSBT = 'cHNidP8BAAoAAAAA==';
const ENRICHED_PSBT = 'ZW5yaWNoZWRwc2J0AA==';

// tx-sizer: ceil(10.5 + 68×N + 31×1) for N P2WPKH inputs → 1 P2WPKH output (hot wallet)
const VBYTES_1_INPUT = 110;  // ceil(10.5 + 68 + 31) = ceil(109.5) = 110
const VBYTES_3_INPUTS = 246; // ceil(10.5 + 204 + 31) = ceil(245.5) = 246

type MockAdapter = {
  chain: string;
  estimateFeeRateSatVb: jest.Mock;
  buildSweepPsbt: jest.Mock;
  walletCreateFundedPsbt: jest.Mock;
  isValidAddress: jest.Mock;
  provisionTenantWallet: jest.Mock;
  importAddressForTenant: jest.Mock;
  batchImportAddresses: jest.Mock;
  getBlockCount: jest.Mock;
  getAddressBalance: jest.Mock;
  getWalletUtxos: jest.Mock;
  getUtxosForAddress: jest.Mock;
  [key: string]: any;
};

let mockAdapter: MockAdapter;
let depositWalletId: string;

beforeAll(() => {
  mockAdapter = {
    chain: 'bitcoin',
    estimateFeeRateSatVb: jest.fn().mockResolvedValue(5),
    buildSweepPsbt: jest.fn().mockResolvedValue(FAKE_PSBT),
    walletCreateFundedPsbt: jest.fn(),
    isValidAddress: jest.fn().mockReturnValue(true),
    provisionTenantWallet: jest.fn().mockResolvedValue(undefined),
    importAddressForTenant: jest.fn().mockResolvedValue(undefined),
    batchImportAddresses: jest.fn().mockResolvedValue(undefined),
    getBlockCount: jest.fn().mockResolvedValue(1000),
    getAddressBalance: jest.fn().mockResolvedValue({ confirmed: '0', unconfirmed: '0', total: '0' }),
    getWalletUtxos: jest.fn().mockResolvedValue([]),
    getUtxosForAddress: jest.fn().mockResolvedValue([]),
  };
  (BitcoinAdapter as jest.MockedClass<typeof BitcoinAdapter>).mockImplementation(() => mockAdapter as any);
});

afterEach(() => { closeDb(); resetDbClient(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

let _utxoSeq = 0;

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
    txHash, vout, String(amountSats), confirmations, now, now,
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
    "SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits' LIMIT 1",
  ).get(TENANT_ID) as { id: string } | undefined;
  if (!depositWallet) throw new Error('seed did not create a customer_deposits wallet for tenant_default');

  depositWalletId = depositWallet.id;

  db.prepare(`
    INSERT INTO addresses
      (id, tenant_id, customer_id, wallet_id, chain_id, address, label,
       address_type, status, address_role, metadata, created_at, updated_at)
    VALUES (?, ?, NULL, ?, 'bitcoin', ?, NULL, 'p2wpkh', 'active', 'customer_deposit', NULL, ?, ?)
  `).run('addr_dep_sw_test', TENANT_ID, depositWalletId, DEPOSIT_ADDRESS, now, now);

  mockAdapter.estimateFeeRateSatVb.mockReset().mockResolvedValue(5);
  mockAdapter.buildSweepPsbt.mockReset().mockResolvedValue(FAKE_PSBT);
  mockAdapter.walletCreateFundedPsbt.mockReset();
  mockAdapter.getUtxosForAddress.mockReset().mockResolvedValue([]);

  // Default: enrichSweepPsbt passes PSBT through unchanged (real function handles empty inputs)
  (enrichSweepPsbt as jest.Mock).mockReset().mockImplementation((psbt: string) => Promise.resolve(psbt));
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

/** Returns the outputSats bigint passed as 3rd argument to adapter.buildSweepPsbt. */
function capturedOutputSats(): bigint {
  const [, , outputSats] = mockAdapter.buildSweepPsbt.mock.calls[0];
  return outputSats as bigint;
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

    await new SweepWorker().run();

    expect(mockAdapter.buildSweepPsbt).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(0);
  });
});

// ── PSBT creation method ──────────────────────────────────────────────────────

describe('PSBT creation uses buildSweepPsbt, not walletCreateFundedPsbt', () => {
  it('calls buildSweepPsbt (regression: addr() descriptors are not solvable for walletCreateFundedPsbt)', async () => {
    await bootstrap();
    insertUtxo('tx_rg01');

    await new SweepWorker().run();

    expect(mockAdapter.buildSweepPsbt).toHaveBeenCalledTimes(1);
    expect(mockAdapter.walletCreateFundedPsbt).not.toHaveBeenCalled();
  });

  it('passes UTXOs as { txHash, vout } array to buildSweepPsbt', async () => {
    await bootstrap();
    insertUtxo('deadbeef', 2);

    await new SweepWorker().run();

    const [utxos] = mockAdapter.buildSweepPsbt.mock.calls[0];
    expect(utxos).toEqual([{ txHash: 'deadbeef', vout: 2, address: DEPOSIT_ADDRESS, amount: '500000' }]);
  });

  it('passes hot-address as outputAddress to buildSweepPsbt', async () => {
    await bootstrap();
    insertUtxo('tx_out01', 0, 500_000);
    mockAdapter.estimateFeeRateSatVb.mockResolvedValue(0);

    await new SweepWorker().run();

    const [, outputAddress] = mockAdapter.buildSweepPsbt.mock.calls[0];
    expect(outputAddress).toBe(getHotAddress());
  });
});

// ── Fee calculation ───────────────────────────────────────────────────────────

describe('Fee calculation', () => {
  it('uses feeRate from estimateFeeRateSatVb (adapter encapsulates estimation + caching)', async () => {
    await bootstrap();
    mockAdapter.estimateFeeRateSatVb.mockResolvedValue(10);
    insertUtxo('tx_reg_fee01', 0, 500_000);

    await new SweepWorker().run();

    expect(sweepCount()).toBe(1);
  });

  it('passes btc_fee_target_blocks from tenant_configs to estimateFeeRateSatVb', async () => {
    await bootstrap();
    insertUtxo('tx_target01', 0, 500_000);

    await new SweepWorker().run();

    expect(mockAdapter.estimateFeeRateSatVb).toHaveBeenCalledWith(
      expect.objectContaining({ targetBlocks: 6 }),
    );
  });

  it('deducts feeRate × ceil(10.5 + 68×1 + 31) sats for a single P2WPKH input', async () => {
    await bootstrap();
    mockAdapter.estimateFeeRateSatVb.mockResolvedValue(10);
    insertUtxo('tx_fee1in', 0, 500_000);

    await new SweepWorker().run();

    const expectedSats = 500_000 - 10 * VBYTES_1_INPUT;
    expect(capturedOutputSats()).toBe(BigInt(expectedSats));
  });

  it('scales fee with number of inputs: 3 inputs → fee = feeRate × ceil(10.5 + 68×3 + 31)', async () => {
    await bootstrap({ thresholdSats: '10000' });
    mockAdapter.estimateFeeRateSatVb.mockResolvedValue(2);
    insertUtxo('tx_3in_a', 0, 50_000);
    insertUtxo('tx_3in_b', 1, 50_000);
    insertUtxo('tx_3in_c', 2, 50_000);

    await new SweepWorker().run();

    const expectedSats = 150_000 - 2 * VBYTES_3_INPUTS;
    expect(capturedOutputSats()).toBe(BigInt(expectedSats));
  });

  it('stores fee_raw = feeRate × vbytes in the sweep record', async () => {
    await bootstrap();
    mockAdapter.estimateFeeRateSatVb.mockResolvedValue(10);
    insertUtxo('tx_feerec01', 0, 500_000);

    await new SweepWorker().run();

    expect(getOnlySweep().fee_raw).toBe(String(10 * VBYTES_1_INPUT));
  });

  it('uses fallback rate (5 sat/vB) when estimateFeeRateSatVb returns fallback', async () => {
    await bootstrap();
    mockAdapter.estimateFeeRateSatVb.mockResolvedValue(5);
    insertUtxo('tx_fallback01', 0, 500_000);

    await new SweepWorker().run();

    const expectedSats = 500_000 - 5 * VBYTES_1_INPUT;
    expect(capturedOutputSats()).toBe(BigInt(expectedSats));
  });
});

// ── Dust threshold ────────────────────────────────────────────────────────────

describe('Dust threshold guard (output ≤ 546 sats)', () => {
  it('skips when fee consumes enough that output ≤ 546 sats', async () => {
    await bootstrap({ thresholdSats: '100' });
    mockAdapter.estimateFeeRateSatVb.mockResolvedValue(5);
    insertUtxo('tx_dust01', 0, 1_000);

    await new SweepWorker().run();

    expect(mockAdapter.buildSweepPsbt).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(0);
  });

  it('proceeds when output after fee is above 546 sats', async () => {
    await bootstrap({ thresholdSats: '100' });
    mockAdapter.estimateFeeRateSatVb.mockResolvedValue(1);
    insertUtxo('tx_nodust01', 0, 1_000);

    await new SweepWorker().run();

    expect(mockAdapter.buildSweepPsbt).toHaveBeenCalledTimes(1);
  });
});

// ── Pre-condition checks ──────────────────────────────────────────────────────

describe('Pre-condition checks', () => {
  it('skips when totalSats < threshold', async () => {
    await bootstrap({ thresholdSats: '500000' });
    insertUtxo('tx_below01', 0, 100_000);

    await new SweepWorker().run();

    expect(mockAdapter.buildSweepPsbt).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(0);
  });

  it('skips when there are no deposit UTXOs in cached_utxos', async () => {
    await bootstrap();

    await new SweepWorker().run();

    expect(mockAdapter.buildSweepPsbt).not.toHaveBeenCalled();
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

    expect(mockAdapter.buildSweepPsbt).not.toHaveBeenCalled();
    expect(sweepCount()).toBe(1);
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

  it('stores the PSBT returned by buildSweepPsbt (after enrichment pass-through)', async () => {
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
    expect(mockAdapter.buildSweepPsbt).toHaveBeenCalledTimes(1);
  });

  it('creates a signing task linked to the sweep', async () => {
    await bootstrap();
    insertUtxo('tx_task01', 0, 500_000);

    await new SweepWorker().run();

    const sweep = getOnlySweep();
    expect(sweep.signing_task_id).not.toBeNull();

    const task = getDb()
      .prepare('SELECT * FROM signing_tasks WHERE id = ?')
      .get(sweep.signing_task_id) as any;
    expect(task).toBeDefined();
    expect(task.request_type).toBe('btc_sweep');
    expect(task.sweep_id).toBe(sweep.id);
  });
});

// ── PSBT enrichment ───────────────────────────────────────────────────────────

describe('PSBT enrichment', () => {
  it('calls enrichSweepPsbt after buildSweepPsbt', async () => {
    await bootstrap();
    insertUtxo('tx_enr_call01', 0, 500_000);

    await new SweepWorker().run();

    expect(enrichSweepPsbt as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('stores enriched PSBT in sweep record when enrichment succeeds', async () => {
    await bootstrap();
    (enrichSweepPsbt as jest.Mock).mockResolvedValueOnce(ENRICHED_PSBT);
    insertUtxo('tx_enr_stored01', 0, 500_000);

    await new SweepWorker().run();

    expect(getOnlySweep().psbt).toBe(ENRICHED_PSBT);
  });

  it('creates sweep with unenriched PSBT when enrichSweepPsbt throws (non-fatal)', async () => {
    await bootstrap();
    (enrichSweepPsbt as jest.Mock).mockRejectedValueOnce(new Error('enrich failed'));
    insertUtxo('tx_enr_fail01', 0, 500_000);

    await new SweepWorker().run();

    expect(sweepCount()).toBe(1);
    expect(getOnlySweep().psbt).toBe(FAKE_PSBT);
  });

  it('aborts sweep when buildSweepPsbt itself throws', async () => {
    await bootstrap();
    mockAdapter.buildSweepPsbt.mockRejectedValueOnce(new Error('rpc error'));
    insertUtxo('tx_enr_rpcfail01', 0, 500_000);

    await new SweepWorker().run();

    expect(sweepCount()).toBe(0);
    expect(enrichSweepPsbt as jest.Mock).not.toHaveBeenCalled();
  });
});

// ── Recovery: orphaned sweep ──────────────────────────────────────────────────

describe('Recovery: orphaned sweep with no signing_task_id', () => {
  it('creates and links a signing task for a sweep that has none', async () => {
    await bootstrap();
    const hotAddress = getHotAddress();

    const sweep = await sweepsService.create(TENANT_ID, {
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      fromAddresses: [DEPOSIT_ADDRESS],
      toAddress: hotAddress,
      amountRaw: '500000',
      feeRaw: '550',
      psbt: FAKE_PSBT,
    });
    // Deliberately NOT calling linkSigningTask — sweep is orphaned

    await new SweepWorker().run();

    const updated = await sweepsService.getByIdInternal(sweep.id);
    expect(updated.signing_task_id).not.toBeNull();

    const task = getDb()
      .prepare('SELECT * FROM signing_tasks WHERE id = ?')
      .get(updated.signing_task_id) as any;
    expect(task).toBeDefined();
    expect(task.request_type).toBe('btc_sweep');
    expect(task.sweep_id).toBe(sweep.id);
  });

  it('does NOT build a new sweep when recovering an orphaned one', async () => {
    await bootstrap();
    const hotAddress = getHotAddress();
    insertUtxo('tx_orp_nosweep', 0, 500_000);

    await sweepsService.create(TENANT_ID, {
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      fromAddresses: [DEPOSIT_ADDRESS],
      toAddress: hotAddress,
      amountRaw: '500000',
      feeRaw: '550',
      psbt: FAKE_PSBT,
    });

    await new SweepWorker().run();

    expect(sweepCount()).toBe(1);
    expect(mockAdapter.buildSweepPsbt).not.toHaveBeenCalled();
  });
});

// ── Recovery: expired/failed signing task ─────────────────────────────────────

describe('Recovery: expired or failed signing task', () => {
  it('recreates signing task when the existing task has status "expired"', async () => {
    await bootstrap();
    const hotAddress = getHotAddress();

    const sweep = await sweepsService.create(TENANT_ID, {
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      fromAddresses: [DEPOSIT_ADDRESS],
      toAddress: hotAddress,
      amountRaw: '500000',
      feeRaw: '550',
      psbt: FAKE_PSBT,
    });

    const oldTask = await signingTasksService.create({
      tenantId: TENANT_ID,
      signerId: null,
      requestType: 'btc_sweep',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      sweepId: sweep.id,
      amountRaw: '500000',
      feeRaw: '550',
      payloadFormat: 'btc_psbt',
      unsignedPayload: FAKE_PSBT,
      decisionMode: 'auto',
    });
    await sweepsService.linkSigningTask(sweep.id, oldTask.id);
    getDb().prepare("UPDATE signing_tasks SET status = 'expired' WHERE id = ?").run(oldTask.id);

    await new SweepWorker().run();

    const updated = await sweepsService.getByIdInternal(sweep.id);
    expect(updated.signing_task_id).not.toBe(oldTask.id);
    expect(updated.signing_task_id).not.toBeNull();
  });

  it('does NOT recreate signing task when existing task is still pending (active)', async () => {
    await bootstrap();
    const hotAddress = getHotAddress();

    const sweep = await sweepsService.create(TENANT_ID, {
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      fromAddresses: [DEPOSIT_ADDRESS],
      toAddress: hotAddress,
      amountRaw: '500000',
      feeRaw: '550',
      psbt: FAKE_PSBT,
    });

    const task = await signingTasksService.create({
      tenantId: TENANT_ID,
      signerId: null,
      requestType: 'btc_sweep',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      sweepId: sweep.id,
      amountRaw: '500000',
      feeRaw: '550',
      payloadFormat: 'btc_psbt',
      unsignedPayload: FAKE_PSBT,
      decisionMode: 'auto',
    });
    await sweepsService.linkSigningTask(sweep.id, task.id);
    // task status remains 'pending' (default)

    await new SweepWorker().run();

    const updated = await sweepsService.getByIdInternal(sweep.id);
    expect(updated.signing_task_id).toBe(task.id); // unchanged
    expect(mockAdapter.buildSweepPsbt).not.toHaveBeenCalled();
  });
});

// ── UTXO locking ──────────────────────────────────────────────────────────────

describe('UTXO locking after sweep creation', () => {
  it('sets is_locked=1 on swept UTXOs — getSummary returns 0 utxos immediately', async () => {
    await bootstrap();
    insertUtxo('tx_lock01', 0, 175_000);
    insertUtxo('tx_lock02', 0, 100_000);

    await new SweepWorker().run();

    expect(sweepCount()).toBe(1);
    expect(getOnlySweep().status).toBe('pending_signature');

    // All swept UTXOs should be locked
    const db = getDb();
    const locked = db.prepare(
      "SELECT COUNT(*) AS n FROM cached_utxos WHERE is_locked = 1 AND wallet_role = 'customer_deposits'"
    ).get() as { n: number };
    expect(locked.n).toBe(2);

    // getSummary must reflect the locked state — this is the UI bug fix
    const summary = await sweepsService.getSummary(TENANT_ID);
    expect(summary.total_utxos).toBe(0);
    expect(summary.current_total_sats).toBe('0');
    expect(summary.addresses_with_balance).toBe(0);
  });

  it('getSummary returns 0 while sweep is in broadcast status (UTXOs still locked)', async () => {
    await bootstrap();
    insertUtxo('tx_lock03', 0, 175_000);

    await new SweepWorker().run();
    const sweep = getOnlySweep();

    // Simulate broadcast — status changes but UTXOs stay locked until btc-indexer
    await sweepsService.updateStatus(sweep.id, 'broadcast', { txHash: 'deadbeef01' });

    const summary = await sweepsService.getSummary(TENANT_ID);
    expect(summary.total_utxos).toBe(0);
    expect(summary.current_total_sats).toBe('0');
  });

  it('getSummary restores UTXO count after releaseLocksForSweep (sweep failed)', async () => {
    await bootstrap();
    insertUtxo('tx_lock04', 0, 175_000);

    await new SweepWorker().run();
    const sweep = getOnlySweep();

    await sweepsService.updateStatus(sweep.id, 'failed', { error: 'rpc error' });
    await utxoLockService.releaseLocksForSweep(TENANT_ID, sweep.id);

    const summary = await sweepsService.getSummary(TENANT_ID);
    expect(summary.total_utxos).toBe(1);
    expect(summary.current_total_sats).toBe('175000');
  });

  it('marks sweep as failed immediately when lockUtxosForSweep fails (race: UTXO locked between collect and lock)', async () => {
    await bootstrap();
    insertUtxo('tx_lock05', 0, 175_000);

    // Simulate race: another engine instance locks the UTXO after collectSweepableUtxos()
    // but before lockUtxosForSweep(). We do this by mocking lockUtxosForSweep to throw.
    const lockSpy = jest
      .spyOn(utxoLockService, 'lockUtxosForSweep')
      .mockRejectedValueOnce(new Error('UTXO tx_lock05:0 no longer available'));

    await new SweepWorker().run();

    lockSpy.mockRestore();

    // Sweep was created then immediately failed
    expect(sweepCount()).toBe(1);
    expect(getOnlySweep().status).toBe('failed');

    // No utxo_locks records should exist for this sweep
    const lockRows = getDb().prepare(
      "SELECT COUNT(*) AS n FROM utxo_locks WHERE reference_type = 'sweep'"
    ).get() as { n: number };
    expect(lockRows.n).toBe(0);
  });
});
