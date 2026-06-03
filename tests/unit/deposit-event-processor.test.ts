/**
 * DepositEventProcessorWorker unit tests.
 *
 * Tests the deposit confirmation lifecycle:
 *   detected (conf=0) → confirmed (conf≥required) → finalized (conf≥finality)
 */

// jest.mock calls are hoisted — use jest.fn() directly inside factories
jest.mock('../../src/modules/deposits/deposits.service', () => ({
  depositsService: {
    upsert: jest.fn(),
    getByIdInternal: jest.fn(),
    updatePaymentRequestId: jest.fn(),
  },
}));
jest.mock('../../src/modules/ledger/ledger.service', () => ({
  ledgerService: {
    findAccountByCustomerAndAsset: jest.fn(),
    findAccountByWalletAndAsset: jest.fn(),
    addEntry: jest.fn(),
  },
}));
jest.mock('../../src/shared/tickler/tickler.service', () => ({
  ticklerService: { record: jest.fn() },
}));
jest.mock('../../src/modules/webhooks/webhooks.service', () => ({
  webhooksService: { queueEventOnce: jest.fn() },
}));
jest.mock('../../src/modules/payment-requests/payment-requests.service', () => ({
  paymentRequestsService: { updateStatus: jest.fn() },
}));
jest.mock('../../src/db/client', () => ({
  getDbClient: jest.fn(),
}));

import { DepositEventProcessorWorker } from '../../src/workers/deposit-event-processor.worker';
import { getDbClient } from '../../src/db/client';
import { depositsService } from '../../src/modules/deposits/deposits.service';
import { ledgerService } from '../../src/modules/ledger/ledger.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeChainEvent(confirmations: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 'cevt_test',
    chain_id: 'bitcoin',
    node_id: 'btc-node-1',
    event_type: 'utxo_created',
    tx_hash: 'abc123',
    vout_index: 0,
    address: 'bcrt1qtest',
    amount_raw: '100000',
    block_height: 100,
    block_hash: 'hash100',
    confirmations,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeposit(overrides = {}) {
  return { id: 'dep_test', payment_request_id: null, status: 'detected', confirmations: 0, ...overrides };
}

const ADDR_CTX = { tenant_id: 'tenant_default', customer_id: 'cust_test', wallet_id: null, wallet_role: null };

function makeDb(events: ReturnType<typeof makeChainEvent>[]) {
  let chainEventCallCount = 0;
  return {
    isPostgres: false,
    all: jest.fn(async (sql: string) => {
      if (sql.includes('chain_events')) return chainEventCallCount++ === 0 ? events : [];
      if (sql.includes('payment_requests')) return [];
      return [];
    }),
    get: jest.fn(async (sql: string) => {
      // resolveAddressContext — address lookup must return a valid context
      if (sql.includes('FROM addresses')) return ADDR_CTX;
      if (sql.includes('watched_addresses')) return null;
      // ledger entry existence check — return null so new entries are created
      if (sql.includes('ledger_entries')) return null;
      return null;
    }),
    run: jest.fn().mockResolvedValue({ changes: 1 }),
    exec: jest.fn().mockResolvedValue(undefined),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  (depositsService.upsert as jest.Mock).mockResolvedValue(makeDeposit());
  (depositsService.getByIdInternal as jest.Mock).mockResolvedValue(makeDeposit());
  (ledgerService.findAccountByCustomerAndAsset as jest.Mock).mockResolvedValue({ id: 'lacc_test' });
  (ledgerService.findAccountByWalletAndAsset as jest.Mock).mockResolvedValue(null);
  (ledgerService.addEntry as jest.Mock).mockResolvedValue(undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DepositEventProcessorWorker — confirmation lifecycle', () => {

  test('processes utxo_created event with conf=0 → calls depositsService.upsert with status=detected', async () => {
    (getDbClient as jest.Mock).mockReturnValue(makeDb([makeChainEvent(0)]));
    await new DepositEventProcessorWorker().run();

    expect(depositsService.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ confirmations: 0, status: 'detected' })
    );
  });

  test('processes utxo_created event with conf=6 → upsert with status confirmed or finalized', async () => {
    (getDbClient as jest.Mock).mockReturnValue(makeDb([makeChainEvent(6)]));
    await new DepositEventProcessorWorker().run();

    expect(depositsService.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmations: 6,
        status: expect.stringMatching(/confirmed|finalized/),
      })
    );
  });

  test('deposits with high confirmations (100) get finalized status', async () => {
    (getDbClient as jest.Mock).mockReturnValue(makeDb([makeChainEvent(100)]));
    await new DepositEventProcessorWorker().run();

    expect(depositsService.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'finalized' })
    );
  });

  test('marks chain_event processed=1 after handling', async () => {
    const db = makeDb([makeChainEvent(0)]);
    (getDbClient as jest.Mock).mockReturnValue(db);
    await new DepositEventProcessorWorker().run();

    const updateCall = (db.run as jest.Mock).mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('processed = 1')
    );
    expect(updateCall).toBeTruthy();
  });

  test('creates pending ledger entry for new deposit (conf=0)', async () => {
    (getDbClient as jest.Mock).mockReturnValue(makeDb([makeChainEvent(0)]));
    await new DepositEventProcessorWorker().run();

    expect(ledgerService.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'deposit_pending' })
    );
  });

  test('creates settled ledger entry for finalized deposit (conf=100)', async () => {
    const finalized = makeDeposit({ confirmations: 100, status: 'finalized' });
    (depositsService.upsert as jest.Mock).mockResolvedValue(finalized);
    (depositsService.getByIdInternal as jest.Mock).mockResolvedValue(finalized);
    (getDbClient as jest.Mock).mockReturnValue(makeDb([makeChainEvent(100)]));

    await new DepositEventProcessorWorker().run();

    expect(ledgerService.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'deposit_settled' })
    );
  });

  test('does nothing when no unprocessed events exist', async () => {
    (getDbClient as jest.Mock).mockReturnValue(makeDb([]));
    await new DepositEventProcessorWorker().run();

    expect(depositsService.upsert).not.toHaveBeenCalled();
  });

  test('skips event with missing address or amount_raw', async () => {
    const event = makeChainEvent(0, { address: null, amount_raw: null });
    const db = makeDb([event]);
    (getDbClient as jest.Mock).mockReturnValue(db);

    await new DepositEventProcessorWorker().run();

    // Event is processed (marked processed=1) but deposit upsert is skipped
    expect(depositsService.upsert).not.toHaveBeenCalled();
  });
});
