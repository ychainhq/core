import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { closeDb, getDb } from '../../src/db/sqlite';
import { adapterRegistry } from '../../src/chain-adapters/registry';
import { IChainAdapter, Utxo } from '../../src/chain-adapters/types';
import { BitcoinAdapter } from '../../src/chain-adapters/bitcoin/adapter';
import { DepositMonitorWorker } from '../../src/workers/deposit-monitor.worker';
import { customersService } from '../../src/modules/customers/customers.service';
import { ledgerService } from '../../src/modules/ledger/ledger.service';
import { paymentRequestsService } from '../../src/modules/payment-requests/payment-requests.service';
import { webhooksService } from '../../src/modules/webhooks/webhooks.service';

const TENANT_ID = 'tenant_default';
const ASSET_ID = 'bitcoin:BTC';
const ADDRESS = 'bc1qdepositmonitor000000000000000000000000000000';
const AMOUNT_RAW = '5000000000';

let utxos: Utxo[] = [];

const adapter = {
  chain: 'bitcoin',
  getBlockCount: jest.fn(async () => 1000),
  getUtxosForAddress: jest.fn(async () => utxos),
  isValidAddress: jest.fn(() => true),
  getBlockchainInfo: jest.fn(),
  getBlockHash: jest.fn(),
  getBlock: jest.fn(),
  getRawTransaction: jest.fn(),
  getRawMempool: jest.fn(),
  getTransactionStatus: jest.fn(),
  getAddressBalance: jest.fn(),
  estimateSmartFee: jest.fn(),
  testMempoolAccept: jest.fn(),
  sendRawTransaction: jest.fn(),
  decodeRawTransaction: jest.fn(),
  decodePsbt: jest.fn(),
  walletCreateFundedPsbt: jest.fn(),
  finalizePsbt: jest.fn(),
} as unknown as IChainAdapter;

function utxo(txHash: string, confirmations: number): Utxo {
  return {
    txHash,
    vout: 0,
    address: ADDRESS,
    amount: AMOUNT_RAW,
    scriptPubKey: '0014'.padEnd(44, '0'),
    confirmations,
    height: confirmations > 0 ? 900 : null,
  };
}

async function bootstrap() {
  closeDb();
  runMigrations();
  await runSeed();
  adapterRegistry.register(adapter);
  utxos = [];

  const db = getDb();
  const now = new Date().toISOString();
  const customer = customersService.create(TENANT_ID, {
    reference: `cust_${Math.random().toString(16).slice(2)}`,
    display_name: 'Deposit Monitor Test Customer',
  });
  const walletId = `wallet_${Math.random().toString(16).slice(2, 14)}`;

  db.prepare(`
    INSERT INTO wallets (id, tenant_id, name, type, status, wallet_role, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'watch_only', 'active', 'customer_deposits', NULL, ?, ?)
  `).run(walletId, TENANT_ID, 'Deposit Monitor Test Wallet', now, now);

  db.prepare(`
    INSERT INTO addresses
      (id, tenant_id, customer_id, wallet_id, chain_id, address, label, address_type, status, address_role, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'bitcoin', ?, NULL, 'p2wpkh', 'active', 'customer_deposit', NULL, ?, ?)
  `).run(`addr_${Math.random().toString(16).slice(2, 14)}`, TENANT_ID, customer.id, walletId, ADDRESS, now, now);

  db.prepare(`
    INSERT INTO watched_addresses
      (id, tenant_id, customer_id, chain_id, address, wallet_id, label, events, webhook_id, is_active, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'bitcoin', ?, ?, NULL, '["incoming"]', NULL, 1, NULL, ?, ?)
  `).run(`mon_${Math.random().toString(16).slice(2, 14)}`, TENANT_ID, customer.id, ADDRESS, walletId, now, now);

  webhooksService.create(TENANT_ID, {
    url: 'https://example.com/deposit-monitor',
    events: ['*'],
    secret: 'deposit-monitor-secret',
  });

  const account = ledgerService.findAccountByCustomerAndAsset(TENANT_ID, customer.id, ASSET_ID);
  if (!account) throw new Error('customer ledger account was not provisioned');

  return { customerId: customer.id, walletId, ledgerAccountId: account.id };
}

function deliveryCount(eventType: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS count FROM webhook_deliveries WHERE event_type = ?')
    .get(eventType) as { count: number };
  return row.count;
}

function ledgerEntryCount(ledgerAccountId: string, type: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS count FROM ledger_entries WHERE ledger_account_id = ? AND type = ?')
    .get(ledgerAccountId, type) as { count: number };
  return row.count;
}

function getOnlyDeposit() {
  return getDb().prepare('SELECT * FROM deposits LIMIT 1').get() as any;
}

describe('DepositMonitorWorker deposit lifecycle effects', () => {
  afterEach(() => {
    adapterRegistry.register(new BitcoinAdapter());
    closeDb();
  });

  it('settles and emits confirmed effects when a new deposit is first seen as finalized', async () => {
    const ctx = await bootstrap();
    paymentRequestsService.create(TENANT_ID, {
      chain: 'bitcoin',
      asset: 'BTC',
      address: ADDRESS,
      walletId: ctx.walletId,
      customerId: ctx.customerId,
      amount: '50',
      confirmationsRequired: 1,
    });
    utxos = [utxo('tx_new_finalized', 10)];

    const worker = new DepositMonitorWorker();
    await worker.run();
    await worker.run();

    const deposit = getOnlyDeposit();
    expect(deposit.status).toBe('finalized');
    expect(deposit.confirmations).toBe(10);

    expect(ledgerService.getBalance(ctx.ledgerAccountId)).toEqual({
      pending: '0',
      settled: AMOUNT_RAW,
      total: AMOUNT_RAW,
    });
    expect(ledgerEntryCount(ctx.ledgerAccountId, 'deposit_pending')).toBe(1);
    expect(ledgerEntryCount(ctx.ledgerAccountId, 'deposit_settled')).toBe(1);

    expect(deliveryCount('deposit.detected')).toBe(1);
    expect(deliveryCount('deposit.confirmed')).toBe(1);
    expect(deliveryCount('payment_request.detected')).toBe(1);
    expect(deliveryCount('payment_request.paid')).toBe(1);
  });

  it('settles and pays a linked payment request when a detected deposit skips directly to finalized', async () => {
    const ctx = await bootstrap();
    const paymentRequest = paymentRequestsService.create(TENANT_ID, {
      chain: 'bitcoin',
      asset: 'BTC',
      address: ADDRESS,
      walletId: ctx.walletId,
      customerId: ctx.customerId,
      amount: '50',
      confirmationsRequired: 1,
    });
    utxos = [utxo('tx_detected_to_finalized', 0)];

    const worker = new DepositMonitorWorker();
    await worker.run();
    expect(ledgerService.getBalance(ctx.ledgerAccountId)).toEqual({
      pending: AMOUNT_RAW,
      settled: '0',
      total: AMOUNT_RAW,
    });
    expect(deliveryCount('deposit.confirmed')).toBe(0);
    expect(paymentRequestsService.getById(TENANT_ID, paymentRequest.id).status).toBe('detected');

    utxos = [utxo('tx_detected_to_finalized', 10)];
    await worker.run();
    await worker.run();

    expect(getOnlyDeposit().status).toBe('finalized');
    expect(ledgerService.getBalance(ctx.ledgerAccountId)).toEqual({
      pending: '0',
      settled: AMOUNT_RAW,
      total: AMOUNT_RAW,
    });
    expect(paymentRequestsService.getById(TENANT_ID, paymentRequest.id).status).toBe('paid');
    expect(deliveryCount('deposit.detected')).toBe(1);
    expect(deliveryCount('deposit.confirmed')).toBe(1);
    expect(deliveryCount('payment_request.detected')).toBe(1);
    expect(deliveryCount('payment_request.paid')).toBe(1);
    expect(ledgerEntryCount(ctx.ledgerAccountId, 'deposit_settled')).toBe(1);
  });

  it('handles detected to confirmed to finalized without duplicate ledger or webhook effects', async () => {
    const ctx = await bootstrap();
    utxos = [utxo('tx_detected_confirmed_finalized', 0)];

    const worker = new DepositMonitorWorker();
    await worker.run();

    utxos = [utxo('tx_detected_confirmed_finalized', 2)];
    await worker.run();

    expect(getOnlyDeposit().status).toBe('confirmed');
    expect(ledgerService.getBalance(ctx.ledgerAccountId)).toEqual({
      pending: '0',
      settled: AMOUNT_RAW,
      total: AMOUNT_RAW,
    });
    expect(deliveryCount('deposit.confirmed')).toBe(1);

    utxos = [utxo('tx_detected_confirmed_finalized', 7)];
    await worker.run();
    await worker.run();

    expect(getOnlyDeposit().status).toBe('finalized');
    expect(ledgerEntryCount(ctx.ledgerAccountId, 'deposit_pending')).toBe(1);
    expect(ledgerEntryCount(ctx.ledgerAccountId, 'deposit_settled')).toBe(1);
    expect(deliveryCount('deposit.detected')).toBe(1);
    expect(deliveryCount('deposit.confirmed')).toBe(1);
  });

  it('backfills missing settled effects for an already-finalized deposit without duplicating pending', async () => {
    const ctx = await bootstrap();
    utxos = [utxo('tx_historical_finalized', 10)];

    const worker = new DepositMonitorWorker();
    await worker.run();

    getDb().prepare("DELETE FROM ledger_entries WHERE type = 'deposit_settled'").run();
    getDb().prepare("DELETE FROM webhook_deliveries WHERE event_type = 'deposit.confirmed'").run();
    expect(ledgerService.getBalance(ctx.ledgerAccountId)).toEqual({
      pending: AMOUNT_RAW,
      settled: '0',
      total: AMOUNT_RAW,
    });

    await worker.run();
    await worker.run();

    expect(ledgerService.getBalance(ctx.ledgerAccountId)).toEqual({
      pending: '0',
      settled: AMOUNT_RAW,
      total: AMOUNT_RAW,
    });
    expect(ledgerEntryCount(ctx.ledgerAccountId, 'deposit_pending')).toBe(1);
    expect(ledgerEntryCount(ctx.ledgerAccountId, 'deposit_settled')).toBe(1);
    expect(deliveryCount('deposit.confirmed')).toBe(1);
  });
});
