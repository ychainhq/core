/**
 * DepositEventProcessorWorker unit tests.
 *
 * Deposit lifecycle: detected (conf < N) → confirmed (conf ≥ N, exactly once).
 * N = tenant_configs.btc_confirmations_required (per-tenant).
 */

jest.mock('../../src/modules/chain-events/chain-events.service', () => ({
  chainEventsService: {
    fetchUnprocessed: jest.fn(),
    markProcessed: jest.fn(),
  },
}));
jest.mock('../../src/modules/deposits/deposits.service', () => ({
  depositsService: {
    upsert: jest.fn(),
    getByIdInternal: jest.fn(),
    updatePaymentRequestId: jest.fn(),
  },
}));
jest.mock('../../src/modules/addresses/addresses.service', () => ({
  addressesService: { resolveDepositContext: jest.fn() },
}));
jest.mock('../../src/modules/monitors/monitors.service', () => ({
  monitorsService: { findActiveByAddress: jest.fn() },
}));
jest.mock('../../src/modules/payment-requests/payment-requests.service', () => ({
  paymentRequestsService: {
    findPendingByAddressInternal: jest.fn(),
    updateStatus: jest.fn(),
  },
}));
jest.mock('../../src/modules/ledger/ledger.service', () => ({
  ledgerService: {
    findAccountByCustomerAndAsset: jest.fn(),
    findAccountByWalletAndAsset: jest.fn(),
    ensureDepositEntry: jest.fn(),
  },
}));
jest.mock('../../src/shared/utxo-lock/utxo-lock.service', () => ({
  utxoLockService: {
    upsertFromDeposit: jest.fn(),
    markSpentByUtxo: jest.fn(),
  },
}));
jest.mock('../../src/shared/tickler/tickler.service', () => ({
  ticklerService: { record: jest.fn() },
}));
jest.mock('../../src/modules/webhooks/webhooks.service', () => ({
  webhooksService: { queueEventOnce: jest.fn() },
}));
jest.mock('../../src/modules/tenants/tenants.service', () => ({
  tenantsService: { getConfirmationsRequired: jest.fn() },
}));

import { DepositEventProcessorWorker } from '../../src/workers/deposit-event-processor.worker';
import { chainEventsService } from '../../src/modules/chain-events/chain-events.service';
import { depositsService } from '../../src/modules/deposits/deposits.service';
import { addressesService } from '../../src/modules/addresses/addresses.service';
import { ledgerService } from '../../src/modules/ledger/ledger.service';
import { utxoLockService } from '../../src/shared/utxo-lock/utxo-lock.service';
import { ticklerService } from '../../src/shared/tickler/tickler.service';
import { tenantsService } from '../../src/modules/tenants/tenants.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeChainEvent(confirmations: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 'cevt_test',
    chain_id: 'bitcoin',
    node_id: 'btc-node-1',
    event_type: 'utxo_created',
    tx_hash: 'abc123',
    vout_index: 0,
    spent_tx_hash: null,
    spent_vout: null,
    address: 'bcrt1qtest',
    amount_raw: '100000',
    block_height: 100,
    block_hash: 'hash100',
    confirmations,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeposit(overrides: Record<string, unknown> = {}) {
  return { id: 'dep_test', payment_request_id: null, status: 'detected', confirmations: 0, ...overrides };
}

function makeUpsertResult(
  depositOverrides: Record<string, unknown> = {},
  isNew = true,
  previousStatus: string | null = null,
) {
  return { deposit: makeDeposit(depositOverrides), isNew, previousStatus };
}

const ADDR_CTX = { tenant_id: 'tenant_default', customer_id: 'cust_test', wallet_id: null, wallet_role: null };

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Chain events: one event by default, then empty
  let callCount = 0;
  (chainEventsService.fetchUnprocessed as jest.Mock).mockImplementation(async () =>
    callCount++ === 0 ? [makeChainEvent(0)] : []
  );
  (chainEventsService.markProcessed as jest.Mock).mockResolvedValue(undefined);

  // Address resolution: returns valid context
  (addressesService.resolveDepositContext as jest.Mock).mockResolvedValue(ADDR_CTX);

  // Tenant confirmation threshold: 1 block
  (tenantsService.getConfirmationsRequired as jest.Mock).mockResolvedValue(1);

  // Deposits
  (depositsService.upsert as jest.Mock).mockResolvedValue(makeUpsertResult());
  (depositsService.getByIdInternal as jest.Mock).mockResolvedValue(makeDeposit());

  // Payment requests: none pending
  const { paymentRequestsService } = require('../../src/modules/payment-requests/payment-requests.service');
  (paymentRequestsService.findPendingByAddressInternal as jest.Mock).mockResolvedValue([]);

  // Ledger
  (ledgerService.findAccountByCustomerAndAsset as jest.Mock).mockResolvedValue({ id: 'lacc_test' });
  (ledgerService.findAccountByWalletAndAsset as jest.Mock).mockResolvedValue(null);
  (ledgerService.ensureDepositEntry as jest.Mock).mockResolvedValue(undefined);

  // UTXO lock
  (utxoLockService.upsertFromDeposit as jest.Mock).mockResolvedValue(undefined);
  (utxoLockService.markSpentByUtxo as jest.Mock).mockResolvedValue(undefined);
});

// ─── Confirmation lifecycle ───────────────────────────────────────────────────

describe('DepositEventProcessorWorker — confirmation lifecycle', () => {

  test('conf=0 → upsert with status=detected', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(0)]);
    await new DepositEventProcessorWorker().run();

    expect(depositsService.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ confirmations: 0, status: 'detected' })
    );
  });

  test('conf=1 (≥ required=1) → upsert with status=confirmed', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(1)]);
    await new DepositEventProcessorWorker().run();

    expect(depositsService.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ confirmations: 1, status: 'confirmed' })
    );
  });

  test('conf=100 → upsert with status=confirmed (no finalized state)', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(100)]);
    await new DepositEventProcessorWorker().run();

    expect(depositsService.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'confirmed' })
    );
  });

  test('marks chain_events as processed', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(0)]);
    await new DepositEventProcessorWorker().run();

    expect(chainEventsService.markProcessed).toHaveBeenCalledWith(['cevt_test']);
  });

  test('calls upsertFromDeposit on utxo-lock service', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(0)]);
    await new DepositEventProcessorWorker().run();

    expect(utxoLockService.upsertFromDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: 'abc123', vout: 0, confirmations: 0 })
    );
  });

  test('creates pending ledger entry for new deposit (conf=0)', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(0)]);
    await new DepositEventProcessorWorker().run();

    expect(ledgerService.ensureDepositEntry).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: 'deposit_pending' })
    );
  });

  test('creates settled ledger entry when deposit transitions to confirmed', async () => {
    const confirmed = makeDeposit({ confirmations: 1, status: 'confirmed' });
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(1)]);
    (depositsService.upsert as jest.Mock).mockResolvedValue({ deposit: confirmed, isNew: false, previousStatus: 'detected' });
    (depositsService.getByIdInternal as jest.Mock).mockResolvedValue(confirmed);

    await new DepositEventProcessorWorker().run();

    expect(ledgerService.ensureDepositEntry).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: 'deposit_settled' })
    );
  });

  test('does nothing when no unprocessed events exist', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([]);
    await new DepositEventProcessorWorker().run();

    expect(depositsService.upsert).not.toHaveBeenCalled();
  });

  test('skips event with missing address or amount_raw', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([
      makeChainEvent(0, { address: null, amount_raw: null }),
    ]);
    await new DepositEventProcessorWorker().run();

    expect(depositsService.upsert).not.toHaveBeenCalled();
  });

  test('utxo_spent event calls markSpentByUtxo', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([
      makeChainEvent(1, { event_type: 'utxo_spent', spent_tx_hash: 'abc123', spent_vout: 0, address: null, amount_raw: null }),
    ]);
    await new DepositEventProcessorWorker().run();

    expect(utxoLockService.markSpentByUtxo).toHaveBeenCalledWith('bitcoin', 'abc123', 0);
    expect(depositsService.upsert).not.toHaveBeenCalled();
  });
});

// ─── isNew tickler semantics ──────────────────────────────────────────────────

describe('DepositEventProcessorWorker — isNew tickler semantics', () => {

  test('new deposit (isNew=true, conf=0) fires detected tickler', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(0)]);
    (depositsService.upsert as jest.Mock).mockResolvedValue(makeUpsertResult({}, true, null));

    await new DepositEventProcessorWorker().run();

    const detected = (ticklerService.record as jest.Mock).mock.calls.filter(
      (c: unknown[]) => (c[0] as any).subcategory === 'detected'
    );
    expect(detected).toHaveLength(1);
  });

  test('re-processed deposit (isNew=false) does NOT fire detected tickler', async () => {
    const confirmed = makeDeposit({ confirmations: 1, status: 'confirmed' });
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(1)]);
    (depositsService.upsert as jest.Mock).mockResolvedValue({ deposit: confirmed, isNew: false, previousStatus: 'detected' });
    (depositsService.getByIdInternal as jest.Mock).mockResolvedValue(confirmed);

    await new DepositEventProcessorWorker().run();

    const detected = (ticklerService.record as jest.Mock).mock.calls.filter(
      (c: unknown[]) => (c[0] as any).subcategory === 'detected'
    );
    expect(detected).toHaveLength(0);
  });

  test('mempool deposit (isNew=true, conf=0) fires detected but not confirmed', async () => {
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(0)]);
    (depositsService.upsert as jest.Mock).mockResolvedValue(makeUpsertResult({}, true, null));

    await new DepositEventProcessorWorker().run();

    const subcategories = (ticklerService.record as jest.Mock).mock.calls.map(
      (c: unknown[]) => (c[0] as any).subcategory
    );
    expect(subcategories).toContain('detected');
    expect(subcategories).not.toContain('confirmed');
  });

  test('block-only deposit (isNew=true, conf=1) fires both detected and confirmed', async () => {
    const confirmed = makeDeposit({ confirmations: 1, status: 'confirmed' });
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(1)]);
    (depositsService.upsert as jest.Mock).mockResolvedValue({ deposit: confirmed, isNew: true, previousStatus: null });
    (depositsService.getByIdInternal as jest.Mock).mockResolvedValue(confirmed);

    await new DepositEventProcessorWorker().run();

    const subcategories = (ticklerService.record as jest.Mock).mock.calls.map(
      (c: unknown[]) => (c[0] as any).subcategory
    );
    expect(subcategories).toContain('detected');
    expect(subcategories).toContain('confirmed');
  });

  test('re-processed already-confirmed deposit (previousStatus=confirmed) fires NO ticklers', async () => {
    const confirmed = makeDeposit({ confirmations: 2, status: 'confirmed' });
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(2)]);
    (depositsService.upsert as jest.Mock).mockResolvedValue({ deposit: confirmed, isNew: false, previousStatus: 'confirmed' });
    (depositsService.getByIdInternal as jest.Mock).mockResolvedValue(confirmed);

    await new DepositEventProcessorWorker().run();

    expect(ticklerService.record).not.toHaveBeenCalled();
  });

  test('transition detected→confirmed (isNew=false, previousStatus=detected) fires confirmed tickler only', async () => {
    const confirmed = makeDeposit({ confirmations: 1, status: 'confirmed' });
    (chainEventsService.fetchUnprocessed as jest.Mock).mockResolvedValueOnce([makeChainEvent(1)]);
    (depositsService.upsert as jest.Mock).mockResolvedValue({ deposit: confirmed, isNew: false, previousStatus: 'detected' });
    (depositsService.getByIdInternal as jest.Mock).mockResolvedValue(confirmed);

    await new DepositEventProcessorWorker().run();

    const subcategories = (ticklerService.record as jest.Mock).mock.calls.map(
      (c: unknown[]) => (c[0] as any).subcategory
    );
    expect(subcategories).not.toContain('detected');
    expect(subcategories).toContain('confirmed');
  });
});
