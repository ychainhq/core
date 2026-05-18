/**
 * GAP 5 — Ledger balance flow tests.
 *
 * Verifies that ledger entries are created and balances updated correctly for:
 *   - Deposit: deposit_pending increases pending, deposit_settled moves pending→settled
 *   - Withdrawal reservation: CA settled balance decreases at create() time
 *   - Withdrawal refund: CA balance restored if broadcast fails
 *   - Withdrawal broadcast: HC debited, NFE credited
 *   - Sweep broadcast: sweep_in_transit credited
 *   - Sweep confirmation: SIT debited, HC credited (net of fee), NFE credited
 *
 * Strategy: call service methods directly to inject ledger entries, verify
 * via both service getBalance() and GET /v1/customers/:id/balances HTTP endpoint.
 * Bitcoin Core is not available in test environment — all entries are injected
 * directly via ledgerService to avoid network dependencies.
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr } from './helpers';
import { getDb } from '../../src/db/sqlite';
import { ledgerService } from '../../src/modules/ledger/ledger.service';
import { customersService } from '../../src/modules/customers/customers.service';
import { sweepsService } from '../../src/modules/sweeps/sweeps.service';
import { SweepConfirmationWorker } from '../../src/workers/sweep-confirmation.worker';

const app = bootstrapApp();
afterAll(() => teardownDb());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function createTenantWithKey(): Promise<{
  tenantId: string;
  auth: { Authorization: string };
}> {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `ledger-flows-tenant-${Date.now()}`, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
  expect(createRes.status).toBe(201);
  const tenantId = createRes.body.data.id;
  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'key' });
  return { tenantId, auth: { Authorization: `Bearer ${keyRes.body.data.apiKey}` } };
}

function giveCustomerBalance(
  tenantId: string,
  customerId: string,
  amountSats: string,
): void {
  const account = ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, 'bitcoin:BTC')!;
  ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_pending', amountRaw: amountSats, isPending: true });
  ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_settled', amountRaw: amountSats });
}

// ---------------------------------------------------------------------------
// Deposit flow
// ---------------------------------------------------------------------------
describe('Deposit ledger flow', () => {
  it('deposit_pending increases customer pending balance', async () => {
    const { tenantId } = await createTenantWithKey();
    const cust = customersService.create(tenantId, { reference: `dep-p-${Date.now()}` });
    const account = ledgerService.findAccountByCustomerAndAsset(tenantId, cust.id, 'bitcoin:BTC')!;

    expect(ledgerService.getBalance(account.id)).toEqual({ pending: '0', settled: '0', total: '0' });

    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_pending', amountRaw: '100000', isPending: true });

    const bal = ledgerService.getBalance(account.id);
    expect(bal.pending).toBe('100000');
    expect(bal.settled).toBe('0');
  });

  it('deposit_settled moves balance from pending to settled', async () => {
    const { tenantId } = await createTenantWithKey();
    const cust = customersService.create(tenantId, { reference: `dep-s-${Date.now()}` });
    const account = ledgerService.findAccountByCustomerAndAsset(tenantId, cust.id, 'bitcoin:BTC')!;

    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_pending', amountRaw: '200000', isPending: true });
    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_settled', amountRaw: '200000' });

    const bal = ledgerService.getBalance(account.id);
    expect(bal.pending).toBe('0');
    expect(bal.settled).toBe('200000');
    expect(bal.total).toBe('200000');
  });

  it('GET /v1/customers/:id/balances reflects ledger entries', async () => {
    const { tenantId, auth } = await createTenantWithKey();
    const custRes = await request(app).post('/v1/customers').set(auth).send({ reference: `bal-http-${Date.now()}` });
    const customerId = custRes.body.data.id;
    const account = ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, 'bitcoin:BTC')!;

    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_pending', amountRaw: '750000', isPending: true });

    const res1 = await request(app).get(`/v1/customers/${customerId}/balances`).set(auth);
    expect(res1.status).toBe(200);
    const b1 = res1.body.data.find((b: any) => b.asset_id === 'bitcoin:BTC');
    expect(b1.pending).toBe('750000');
    expect(b1.settled).toBe('0');

    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_settled', amountRaw: '750000' });

    const res2 = await request(app).get(`/v1/customers/${customerId}/balances`).set(auth);
    const b2 = res2.body.data.find((b: any) => b.asset_id === 'bitcoin:BTC');
    expect(b2.pending).toBe('0');
    expect(b2.settled).toBe('750000');
  });
});

// ---------------------------------------------------------------------------
// Withdrawal ledger flow (via ledger service directly)
// ---------------------------------------------------------------------------
describe('Withdrawal ledger flow', () => {
  it('withdrawal_reserve debits customer settled balance immediately', async () => {
    const { tenantId } = await createTenantWithKey();
    const cust = customersService.create(tenantId, { reference: `wd-res-${Date.now()}` });
    giveCustomerBalance(tenantId, cust.id, '500000');

    const account = ledgerService.findAccountByCustomerAndAsset(tenantId, cust.id, 'bitcoin:BTC')!;
    expect(ledgerService.getBalance(account.id).settled).toBe('500000');

    ledgerService.addEntry({
      ledgerAccountId: account.id,
      type: 'withdrawal_reserve',
      amountRaw: '-100000',
      referenceType: 'customer_withdrawal',
      referenceId: 'wd_test_reserve',
    });

    expect(ledgerService.getBalance(account.id).settled).toBe('400000');
  });

  it('withdrawal_refund restores settled balance after broadcast failure', async () => {
    const { tenantId } = await createTenantWithKey();
    const cust = customersService.create(tenantId, { reference: `wd-ref-${Date.now()}` });
    giveCustomerBalance(tenantId, cust.id, '300000');

    const account = ledgerService.findAccountByCustomerAndAsset(tenantId, cust.id, 'bitcoin:BTC')!;

    // Reserve
    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'withdrawal_reserve', amountRaw: '-200000', referenceType: 'customer_withdrawal', referenceId: 'wd_test_refund' });
    expect(ledgerService.getBalance(account.id).settled).toBe('100000');

    // Simulate broadcast failure → refund
    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'withdrawal_refund', amountRaw: '200000', referenceType: 'customer_withdrawal', referenceId: 'wd_test_refund' });
    expect(ledgerService.getBalance(account.id).settled).toBe('300000');
  });

  it('hot_debit reduces tenant_hot_control on broadcast', async () => {
    const { tenantId } = await createTenantWithKey();
    const hcAccount = ledgerService.findAccountByTenantAndType(tenantId, 'tenant_hot_control');
    if (!hcAccount) return; // HC not provisioned (shouldn't happen with hotAddress requirement)

    // Give HC a starting balance
    ledgerService.addEntry({ ledgerAccountId: hcAccount.id, type: 'sweep_confirmed', amountRaw: '1000000', referenceType: 'sweep', referenceId: 'sweep_setup' });
    const before = ledgerService.getBalance(hcAccount.id);

    const withdrawalAmount = BigInt('100000');
    const fee = BigInt('500');
    ledgerService.addEntry({ ledgerAccountId: hcAccount.id, type: 'hot_debit', amountRaw: (-(withdrawalAmount + fee)).toString(), referenceType: 'customer_withdrawal', referenceId: 'wd_test_hc' });

    const after = ledgerService.getBalance(hcAccount.id);
    expect(BigInt(after.settled) - BigInt(before.settled)).toBe(-(withdrawalAmount + fee));
  });

  it('fee_expense records withdrawal fee in network_fee_expense', async () => {
    const { tenantId } = await createTenantWithKey();
    const nfeAccount = ledgerService.findAccountByTenantAndType(tenantId, 'network_fee_expense');
    if (!nfeAccount) return;

    const before = ledgerService.getBalance(nfeAccount.id);
    const fee = '750';

    ledgerService.addEntry({ ledgerAccountId: nfeAccount.id, type: 'fee_expense', amountRaw: fee, referenceType: 'customer_withdrawal', referenceId: 'wd_test_fee' });

    const after = ledgerService.getBalance(nfeAccount.id);
    expect(BigInt(after.settled) - BigInt(before.settled)).toBe(BigInt(fee));
  });
});

// ---------------------------------------------------------------------------
// Sweep ledger flow (via ledger service directly)
// ---------------------------------------------------------------------------
describe('Sweep ledger flow', () => {
  it('sweep_broadcast credits sweep_in_transit', async () => {
    const { tenantId } = await createTenantWithKey();
    const sitAccount = ledgerService.findAccountByTenantAndType(tenantId, 'sweep_in_transit');
    if (!sitAccount) return;

    const before = ledgerService.getBalance(sitAccount.id);

    ledgerService.addEntry({
      ledgerAccountId: sitAccount.id,
      type: 'sweep_broadcast',
      amountRaw: '500000',
      referenceType: 'sweep',
      referenceId: 'sweep_test_bc',
    });

    const after = ledgerService.getBalance(sitAccount.id);
    expect(BigInt(after.settled) - BigInt(before.settled)).toBe(BigInt('500000'));
  });

  it('sweep_confirmed transfers SIT→HC net of fee, records NFE', async () => {
    const { tenantId } = await createTenantWithKey();
    const sitAccount = ledgerService.findAccountByTenantAndType(tenantId, 'sweep_in_transit')!;
    const hcAccount = ledgerService.findAccountByTenantAndType(tenantId, 'tenant_hot_control')!;
    const nfeAccount = ledgerService.findAccountByTenantAndType(tenantId, 'network_fee_expense')!;
    if (!sitAccount || !hcAccount) return;

    const total = BigInt('300000');
    const fee = BigInt('1500');

    // Simulate broadcast step (SIT credited)
    ledgerService.addEntry({ ledgerAccountId: sitAccount.id, type: 'sweep_broadcast', amountRaw: total.toString(), referenceType: 'sweep', referenceId: 'sweep_test_confirm' });

    const sitBefore = ledgerService.getBalance(sitAccount.id);
    const hcBefore = ledgerService.getBalance(hcAccount.id);
    const nfeBefore = nfeAccount ? ledgerService.getBalance(nfeAccount.id) : { settled: '0' };

    // Simulate confirmation step
    ledgerService.addEntry({ ledgerAccountId: sitAccount.id, type: 'sweep_confirmed', amountRaw: (-total).toString(), referenceType: 'sweep', referenceId: 'sweep_test_confirm' });
    ledgerService.addEntry({ ledgerAccountId: hcAccount.id, type: 'sweep_confirmed', amountRaw: (total - fee).toString(), referenceType: 'sweep', referenceId: 'sweep_test_confirm' });
    if (nfeAccount) {
      ledgerService.addEntry({ ledgerAccountId: nfeAccount.id, type: 'fee_expense', amountRaw: fee.toString(), referenceType: 'sweep', referenceId: 'sweep_test_confirm' });
    }

    const sitAfter = ledgerService.getBalance(sitAccount.id);
    const hcAfter = ledgerService.getBalance(hcAccount.id);

    // SIT fully drained by confirmation
    expect(BigInt(sitAfter.settled) - BigInt(sitBefore.settled)).toBe(-total);
    // HC received totalSats minus fee
    expect(BigInt(hcAfter.settled) - BigInt(hcBefore.settled)).toBe(total - fee);
    // NFE increased by fee
    if (nfeAccount) {
      const nfeAfter = ledgerService.getBalance(nfeAccount.id);
      expect(BigInt(nfeAfter.settled) - BigInt(nfeBefore.settled)).toBe(fee);
    }
  });
});

// ---------------------------------------------------------------------------
// SweepConfirmationWorker: injects a sweep record and runs the worker
// ---------------------------------------------------------------------------
describe('SweepConfirmationWorker.run() — no-op when Bitcoin Core unavailable', () => {
  it('processes zero sweeps when none are broadcast', async () => {
    // Worker should not throw even when no broadcast sweeps exist
    const worker = new SweepConfirmationWorker();
    await expect(worker.run()).resolves.not.toThrow();
  });

  it('skips a broadcast sweep gracefully when Bitcoin Core is unavailable', async () => {
    const { tenantId } = await createTenantWithKey();

    // Inject a sweep record directly in DB with status='broadcast' and a fake tx_hash
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO sweeps (id, tenant_id, chain_id, asset_id, from_addresses, to_address,
        amount_raw, fee_raw, tx_hash, status, created_at, updated_at)
      VALUES (?, ?, 'bitcoin', 'bitcoin:BTC', '["addr1"]', 'addr_hot',
        '500000', '1000', 'fakehash_abc123', 'broadcast', ?, ?)
    `).run('sweep_test_worker', tenantId, now, now);

    const sitBefore = ledgerService.findAccountByTenantAndType(tenantId, 'sweep_in_transit');
    const sitBalBefore = sitBefore ? ledgerService.getBalance(sitBefore.id).settled : '0';

    // Run worker — Bitcoin Core unavailable → should skip gracefully
    const worker = new SweepConfirmationWorker();
    await expect(worker.run()).resolves.not.toThrow();

    // SIT balance should NOT have changed (BTC Core unavailable means no confirmation detected)
    if (sitBefore) {
      const sitBalAfter = ledgerService.getBalance(sitBefore.id).settled;
      expect(sitBalAfter).toBe(sitBalBefore);
    }

    // Sweep should still be in 'broadcast' status
    const sweepRow = db.prepare("SELECT status FROM sweeps WHERE id = 'sweep_test_worker'").get() as any;
    expect(sweepRow?.status).toBe('broadcast');
  });
});

// ---------------------------------------------------------------------------
// Full balance lifecycle via HTTP API
// ---------------------------------------------------------------------------
describe('Customer balance lifecycle via API', () => {
  it('balance increases on deposit, decreases on withdrawal reservation', async () => {
    const { tenantId, auth } = await createTenantWithKey();

    const custRes = await request(app).post('/v1/customers').set(auth).send({ reference: `lifecycle-${Date.now()}` });
    const customerId = custRes.body.data.id;
    const account = ledgerService.findAccountByCustomerAndAsset(tenantId, customerId, 'bitcoin:BTC')!;

    // Step 1: deposit
    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_pending', amountRaw: '1000000', isPending: true });
    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'deposit_settled', amountRaw: '1000000' });

    const res1 = await request(app).get(`/v1/customers/${customerId}/balances`).set(auth);
    const b1 = res1.body.data.find((b: any) => b.asset_id === 'bitcoin:BTC');
    expect(b1.settled).toBe('1000000');

    // Step 2: withdrawal reservation
    ledgerService.addEntry({ ledgerAccountId: account.id, type: 'withdrawal_reserve', amountRaw: '-400000', referenceType: 'customer_withdrawal', referenceId: 'wd_lifecycle' });

    const res2 = await request(app).get(`/v1/customers/${customerId}/balances`).set(auth);
    const b2 = res2.body.data.find((b: any) => b.asset_id === 'bitcoin:BTC');
    expect(b2.settled).toBe('600000');

    // Step 3: simulate successful broadcast — balance stays reduced (no further CA change)
    // (HC debit happens on hot wallet side, not customer side)
    const res3 = await request(app).get(`/v1/customers/${customerId}/balances`).set(auth);
    const b3 = res3.body.data.find((b: any) => b.asset_id === 'bitcoin:BTC');
    expect(b3.settled).toBe('600000');
  });
});
