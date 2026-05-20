import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { closeDb, getDb } from '../../src/db/sqlite';
import { customersService } from '../../src/modules/customers/customers.service';
import { ledgerService } from '../../src/modules/ledger/ledger.service';

const TENANT = 'tenant_default';

beforeAll(async () => {
  closeDb();
  runMigrations();
  await runSeed();
});

afterAll(() => {
  closeDb();
});

describe('customersService.getBalances — aggregation by asset_id', () => {
  it('returns one entry per asset_id, not one per ledger account', () => {
    // Creating a customer provisions TWO ledger accounts for bitcoin:BTC:
    // customer_available + customer_pending. Before the fix this caused 2 rows in the response.
    const customer = customersService.create(TENANT, { reference: 'unit-bal-dedup' });
    const balances = customersService.getBalances(TENANT, customer.id);

    const assetIds = balances.map((b) => b.asset_id);
    const unique = new Set(assetIds);
    expect(unique.size).toBe(assetIds.length);
    expect(assetIds).toContain('bitcoin:BTC');
  });

  it('returns zero balances for a brand-new customer', () => {
    const customer = customersService.create(TENANT, { reference: 'unit-bal-zero' });
    const balances = customersService.getBalances(TENANT, customer.id);

    expect(balances.length).toBe(1);
    const btc = balances[0]!;
    expect(btc.asset_id).toBe('bitcoin:BTC');
    expect(btc.pending).toBe('0');
    expect(btc.settled).toBe('0');
    expect(btc.total).toBe('0');
  });

  it('sums pending and settled across both accounts for the same asset', () => {
    const customer = customersService.create(TENANT, { reference: 'unit-bal-sum' });

    const pendingAcc = getDb()
      .prepare("SELECT id FROM ledger_accounts WHERE customer_id = ? AND account_type = 'customer_pending'")
      .get(customer.id) as { id: string };
    const availableAcc = getDb()
      .prepare("SELECT id FROM ledger_accounts WHERE customer_id = ? AND account_type = 'customer_available'")
      .get(customer.id) as { id: string };

    // Simulate an inbound pending deposit: 50 000 sats into the pending account
    ledgerService.addEntry({
      ledgerAccountId: pendingAcc.id,
      type: 'deposit_pending',
      amountRaw: '50000',
      isPending: true,
    });

    // Simulate a previously-settled deposit: 30 000 sats into the available account
    ledgerService.addEntry({
      ledgerAccountId: availableAcc.id,
      type: 'deposit_settled',
      amountRaw: '30000',
      isPending: false,
    });

    const balances = customersService.getBalances(TENANT, customer.id);
    expect(balances.length).toBe(1);

    const btc = balances[0]!;
    expect(btc.asset_id).toBe('bitcoin:BTC');
    // pending comes from the pending account, settled from the available account
    expect(BigInt(btc.pending) + BigInt(btc.settled)).toBe(BigInt(btc.total));
    // total must reflect both entries
    expect(BigInt(btc.total)).toBeGreaterThan(0n);
  });

  it('throws NOT_FOUND for a non-existent customer', () => {
    expect(() => customersService.getBalances(TENANT, 'cust_does_not_exist')).toThrow();
  });
});
