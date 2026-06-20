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

describe('runSeed — TRON chain + assets enabled', () => {
  it('enables the tron chain', () => {
    const row = getDb()
      .prepare("SELECT id, is_enabled FROM chains WHERE id = 'tron'")
      .get() as { id: string; is_enabled: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.is_enabled).toBe(1);
  });

  it('enables tron:TRX asset', () => {
    const row = getDb()
      .prepare("SELECT id, is_enabled FROM assets WHERE id = 'tron:TRX'")
      .get() as { id: string; is_enabled: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.is_enabled).toBe(1);
  });

  it('enables tron:USDT asset', () => {
    const row = getDb()
      .prepare("SELECT id, is_enabled FROM assets WHERE id = 'tron:USDT'")
      .get() as { id: string; is_enabled: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.is_enabled).toBe(1);
  });
});

describe('runSeed — tenant_default TRON tenant_hot wallet provisioning', () => {
  // TRON and BTC share one tenant_hot wallet; TRON adds addresses + ledger accounts to it.

  it('creates an active TRON address in the tenant_hot wallet', () => {
    const row = getDb()
      .prepare(`
        SELECT a.address, a.status
        FROM addresses a
        JOIN wallets w ON w.id = a.wallet_id
        WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
          AND a.chain_id = 'tron' AND a.status = 'active'
        LIMIT 1
      `)
      .get('tenant_default') as { address: string; status: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.status).toBe('active');
    expect(row!.address).toMatch(/^T[A-Za-z0-9]{33}$/);
  });

  it('creates sweep_in_transit ledger account for TRON', () => {
    const row = getDb()
      .prepare("SELECT id, account_type FROM ledger_accounts WHERE tenant_id = ? AND chain_id = 'tron' AND account_type = 'sweep_in_transit'")
      .get('tenant_default') as { id: string; account_type: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.account_type).toBe('sweep_in_transit');
  });

  it('creates network_fee_expense ledger account for TRON', () => {
    const row = getDb()
      .prepare("SELECT id, account_type FROM ledger_accounts WHERE tenant_id = ? AND chain_id = 'tron' AND account_type = 'network_fee_expense'")
      .get('tenant_default') as { id: string; account_type: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.account_type).toBe('network_fee_expense');
  });

  it('is idempotent — running seed twice does not add a second active TRON address to tenant_hot', async () => {
    await runSeed();

    const rows = getDb()
      .prepare(`
        SELECT a.id
        FROM addresses a
        JOIN wallets w ON w.id = a.wallet_id
        WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
          AND a.chain_id = 'tron' AND a.status = 'active'
      `)
      .all('tenant_default') as { id: string }[];

    expect(rows.length).toBe(1);
  });

  it('is idempotent — running seed twice does not duplicate TRON ledger accounts', async () => {
    await runSeed();

    const sweepRows = getDb()
      .prepare("SELECT id FROM ledger_accounts WHERE tenant_id = ? AND chain_id = 'tron' AND account_type = 'sweep_in_transit'")
      .all('tenant_default') as { id: string }[];

    const feeRows = getDb()
      .prepare("SELECT id FROM ledger_accounts WHERE tenant_id = ? AND chain_id = 'tron' AND account_type = 'network_fee_expense'")
      .all('tenant_default') as { id: string }[];

    expect(sweepRows.length).toBe(1);
    expect(feeRows.length).toBe(1);
  });
});
