import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { closeDb, getDb } from '../../src/db/sqlite';

beforeAll(async () => {
  closeDb();
  runMigrations();
  await runSeed();
});

afterAll(() => {
  closeDb();
});

describe('runSeed — tenant_default BTC LWallet provisioning', () => {
  it('creates a customer_deposits wallet for tenant_default', () => {
    const row = getDb()
      .prepare("SELECT id, wallet_role FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits' LIMIT 1")
      .get('tenant_default') as { id: string; wallet_role: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.wallet_role).toBe('customer_deposits');
  });

  it('creates a ledger account linked to the customer_deposits wallet', () => {
    const wallet = getDb()
      .prepare("SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits' LIMIT 1")
      .get('tenant_default') as { id: string } | undefined;

    expect(wallet).toBeDefined();

    const account = getDb()
      .prepare('SELECT id, account_type FROM ledger_accounts WHERE wallet_id = ? LIMIT 1')
      .get(wallet!.id) as { id: string; account_type: string } | undefined;

    expect(account).toBeDefined();
    expect(account!.account_type).toBe('customer_available');
  });

  it('is idempotent — running seed twice does not duplicate the wallet', async () => {
    await runSeed();

    const rows = getDb()
      .prepare("SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits'")
      .all('tenant_default') as { id: string }[];

    expect(rows.length).toBe(1);
  });
});
