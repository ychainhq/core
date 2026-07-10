import fs from 'fs';
import path from 'path';

const FEEDER_PATH = path.resolve(__dirname, '../../src/workers/tron-sweep-queue-feeder.worker.ts');
const WORKER_PATH = path.resolve(__dirname, '../../src/workers/tron-sweep.worker.ts');

describe('TronSweepQueueFeeder — source code assertions', () => {
  let feederSrc: string;

  beforeAll(() => {
    feederSrc = fs.readFileSync(FEEDER_PATH, 'utf8');
  });

  it('uses ON CONFLICT upsert on tron_sweep_queue to prevent duplicates', () => {
    expect(feederSrc).toContain('ON CONFLICT(address, asset_id) DO UPDATE SET');
  });

  it('has BATCH_SIZE limit to prevent runaway scans', () => {
    expect(feederSrc).toContain('BATCH_SIZE');
    expect(feederSrc).toContain('LIMIT');
  });

  it('computes priority based on balance vs threshold multipliers', () => {
    expect(feederSrc).toContain('PRIORITY_URGENT_MULTIPLIER');
    expect(feederSrc).toContain('PRIORITY_HIGH_MULTIPLIER');
  });

  it('handles both tron:USDT and tron:TRX thresholds', () => {
    expect(feederSrc).toContain('tron:USDT');
    expect(feederSrc).toContain('tron:TRX');
    expect(feederSrc).toContain('tron_usdt_sweep_threshold_sun');
    expect(feederSrc).toContain('tron_trx_sweep_threshold_sun');
  });

  it('falls back to legacy tron_sweep_threshold_sun for USDT', () => {
    expect(feederSrc).toContain('tron_sweep_threshold_sun');
  });

  it('only queries active tenants with xpub set', () => {
    expect(feederSrc).toContain("tron_xpub IS NOT NULL");
    expect(feederSrc).toContain("status = 'active'");
  });
});

describe('TronSweepWorker v2 — queue-draining assertions', () => {
  let workerSrc: string;

  beforeAll(() => {
    workerSrc = fs.readFileSync(WORKER_PATH, 'utf8');
  });

  it("queries wallet_role = 'tenant_hot' for the sweep destination address", () => {
    expect(workerSrc).toContain("wallet_role = 'tenant_hot'");
  });

  it('does NOT query wallet_role = tenant_cold', () => {
    expect(workerSrc).not.toContain('tenant_cold');
  });

  it('handles tron:USDT sweeps with requestType tron_sweep', () => {
    expect(workerSrc).toContain("TRON_USDT_ASSET_ID");
    expect(workerSrc).toContain("'tron_sweep'");
  });

  it('handles tron:TRX sweeps with requestType tron_trx_sweep', () => {
    expect(workerSrc).toContain("TRON_TRX_ASSET_ID");
    expect(workerSrc).toContain("'tron_trx_sweep'");
  });

  it('supports Stake 2.0 energy delegation before USDT sweep', () => {
    expect(workerSrc).toContain('tron_staked_energy_sun');
    expect(workerSrc).toContain('_delegateEnergy');
    expect(workerSrc).toContain('tron_energy_delegations');
  });

  it('drains from tron_sweep_queue (not iterating all addresses)', () => {
    expect(workerSrc).toContain('tron_sweep_queue');
    expect(workerSrc).toContain('QUEUE_BATCH_SIZE');
  });

  it('deletes claimed entries immediately to prevent double-processing', () => {
    expect(workerSrc).toContain('DELETE FROM tron_sweep_queue');
  });

  it('links sweep_id back to tron_energy_delegations after sweep is created', () => {
    // Ensures TronEnergyReclaimWorker can trigger on sweep.confirmed immediately
    // instead of waiting for the 24h timeout
    expect(workerSrc).toContain('UPDATE tron_energy_delegations SET sweep_id');
    expect(workerSrc).toContain('sweep_id IS NULL');
  });
});
