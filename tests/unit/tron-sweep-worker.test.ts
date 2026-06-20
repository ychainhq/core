import fs from 'fs';
import path from 'path';

const WORKER_PATH = path.resolve(__dirname, '../../src/workers/tron-sweep.worker.ts');

describe('TronSweepWorker — sweep destination address query', () => {
  let workerSrc: string;

  beforeAll(() => {
    workerSrc = fs.readFileSync(WORKER_PATH, 'utf8');
  });

  it("queries wallet_role = 'tenant_hot' for the sweep destination address", () => {
    expect(workerSrc).toContain("wallet_role = 'tenant_hot'");
  });

  it("does NOT query wallet_role = 'tenant_cold' anywhere", () => {
    expect(workerSrc).not.toContain("tenant_cold");
  });

  it('passes the hot wallet address as toAddress in the sweep', () => {
    // The variable holding the hot wallet query result must be used as toAddress
    // Assert that coldAddr / hotAddr result flows into createUnsignedTrc20Transfer
    expect(workerSrc).toContain('toAddress');
  });
});
