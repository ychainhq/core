import { resetDbClient } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { closeDb, getDb } from '../../src/db/sqlite';

beforeAll(async () => {
  closeDb();
  resetDbClient();
  runMigrations();
  await runSeed();
});

afterAll(() => {
  closeDb();
  resetDbClient();
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

  it('creates wallet-attached tenant_hot_control ledger account for tron:TRX', () => {
    const hotWallet = getDb()
      .prepare("SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'tenant_hot' LIMIT 1")
      .get('tenant_default') as { id: string } | undefined;

    expect(hotWallet).toBeDefined();

    const account = getDb()
      .prepare(`
        SELECT id, account_type, asset_id
        FROM ledger_accounts
        WHERE wallet_id = ? AND asset_id = 'tron:TRX' AND account_type = 'tenant_hot_control'
      `)
      .get(hotWallet!.id) as { id: string; account_type: string; asset_id: string } | undefined;

    expect(account).toBeDefined();
    expect(account!.account_type).toBe('tenant_hot_control');
    expect(account!.asset_id).toBe('tron:TRX');
  });

  it('creates wallet-attached tenant_hot_control ledger account for tron:USDT', () => {
    const hotWallet = getDb()
      .prepare("SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'tenant_hot' LIMIT 1")
      .get('tenant_default') as { id: string } | undefined;

    expect(hotWallet).toBeDefined();

    const account = getDb()
      .prepare(`
        SELECT id, account_type, asset_id
        FROM ledger_accounts
        WHERE wallet_id = ? AND asset_id = 'tron:USDT' AND account_type = 'tenant_hot_control'
      `)
      .get(hotWallet!.id) as { id: string; account_type: string; asset_id: string } | undefined;

    expect(account).toBeDefined();
    expect(account!.account_type).toBe('tenant_hot_control');
    expect(account!.asset_id).toBe('tron:USDT');
  });

  it('creates sweep_in_transit ledger account for tron:TRX', () => {
    const row = getDb()
      .prepare(`
        SELECT id, account_type, asset_id FROM ledger_accounts
        WHERE tenant_id = ? AND chain_id = 'tron'
          AND account_type = 'sweep_in_transit' AND asset_id = 'tron:TRX'
      `)
      .get('tenant_default') as { id: string; account_type: string; asset_id: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.account_type).toBe('sweep_in_transit');
    expect(row!.asset_id).toBe('tron:TRX');
  });

  it('creates sweep_in_transit ledger account for tron:USDT', () => {
    const row = getDb()
      .prepare(`
        SELECT id, account_type, asset_id FROM ledger_accounts
        WHERE tenant_id = ? AND chain_id = 'tron'
          AND account_type = 'sweep_in_transit' AND asset_id = 'tron:USDT'
      `)
      .get('tenant_default') as { id: string; account_type: string; asset_id: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.account_type).toBe('sweep_in_transit');
    expect(row!.asset_id).toBe('tron:USDT');
  });

  it('creates network_fee_expense ledger account for tron:TRX', () => {
    const row = getDb()
      .prepare(`
        SELECT id, account_type, asset_id FROM ledger_accounts
        WHERE tenant_id = ? AND chain_id = 'tron' AND account_type = 'network_fee_expense'
      `)
      .get('tenant_default') as { id: string; account_type: string; asset_id: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.account_type).toBe('network_fee_expense');
    expect(row!.asset_id).toBe('tron:TRX');
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

    const hotWallet = getDb()
      .prepare("SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'tenant_hot' LIMIT 1")
      .get('tenant_default') as { id: string } | undefined;

    expect(hotWallet).toBeDefined();

    const hotTrxAccounts = getDb()
      .prepare(`
        SELECT id FROM ledger_accounts
        WHERE wallet_id = ? AND asset_id = 'tron:TRX' AND account_type = 'tenant_hot_control'
      `)
      .all(hotWallet!.id) as { id: string }[];

    const hotUsdtAccounts = getDb()
      .prepare(`
        SELECT id FROM ledger_accounts
        WHERE wallet_id = ? AND asset_id = 'tron:USDT' AND account_type = 'tenant_hot_control'
      `)
      .all(hotWallet!.id) as { id: string }[];

    const sweepTrxAccounts = getDb()
      .prepare(`
        SELECT id FROM ledger_accounts
        WHERE tenant_id = ? AND chain_id = 'tron'
          AND account_type = 'sweep_in_transit' AND asset_id = 'tron:TRX'
      `)
      .all('tenant_default') as { id: string }[];

    const sweepUsdtAccounts = getDb()
      .prepare(`
        SELECT id FROM ledger_accounts
        WHERE tenant_id = ? AND chain_id = 'tron'
          AND account_type = 'sweep_in_transit' AND asset_id = 'tron:USDT'
      `)
      .all('tenant_default') as { id: string }[];

    const feeAccounts = getDb()
      .prepare(`
        SELECT id FROM ledger_accounts
        WHERE tenant_id = ? AND chain_id = 'tron' AND account_type = 'network_fee_expense'
      `)
      .all('tenant_default') as { id: string }[];

    expect(hotTrxAccounts.length).toBe(1);
    expect(hotUsdtAccounts.length).toBe(1);
    expect(sweepTrxAccounts.length).toBe(1);
    expect(sweepUsdtAccounts.length).toBe(1);
    expect(feeAccounts.length).toBe(1);
  });
});

describe('runSeed — tron:USDT contract_address default (no env var)', () => {
  let savedEnv: string | undefined;

  beforeAll(async () => {
    savedEnv = process.env['TRON_USDT_CONTRACT_ADDRESS'];
    delete process.env['TRON_USDT_CONTRACT_ADDRESS'];
    closeDb();
    resetDbClient();
    runMigrations();
    await runSeed();
  });

  afterAll(() => {
    if (savedEnv !== undefined) process.env['TRON_USDT_CONTRACT_ADDRESS'] = savedEnv;
    closeDb();
    resetDbClient();
  });

  it('preserves migration default contract_address when TRON_USDT_CONTRACT_ADDRESS is not set', () => {
    const row = getDb()
      .prepare("SELECT specs FROM assets WHERE id = 'tron:USDT'")
      .get() as { specs: string } | undefined;

    expect(row).toBeDefined();
    const specs = JSON.parse(row!.specs);
    expect(specs.contract_address).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  });
});

describe('runSeed — tron:USDT contract_address override from env', () => {
  const TEST_CONTRACT = 'TTestContractAddress1234567890Abc';

  beforeAll(async () => {
    process.env['TRON_USDT_CONTRACT_ADDRESS'] = TEST_CONTRACT;
    closeDb();
    resetDbClient();
    runMigrations();
    await runSeed();
  });

  afterAll(() => {
    delete process.env['TRON_USDT_CONTRACT_ADDRESS'];
    closeDb();
    resetDbClient();
  });

  it('sets tron:USDT specs.contract_address from TRON_USDT_CONTRACT_ADDRESS', () => {
    const row = getDb()
      .prepare("SELECT specs FROM assets WHERE id = 'tron:USDT'")
      .get() as { specs: string } | undefined;

    expect(row).toBeDefined();
    const specs = JSON.parse(row!.specs);
    expect(specs.contract_address).toBe(TEST_CONTRACT);
  });

  it('does not corrupt other specs fields when overriding contract_address', () => {
    const row = getDb()
      .prepare("SELECT specs FROM assets WHERE id = 'tron:USDT'")
      .get() as { specs: string } | undefined;

    expect(row).toBeDefined();
    const specs = JSON.parse(row!.specs);
    // contract_address is the only field in tron:USDT specs per migration 023;
    // seed must not silently drop other fields if they are added in the future.
    expect(Object.keys(specs)).toContain('contract_address');
    expect(typeof specs.contract_address).toBe('string');
  });

  it('is idempotent — running seed twice with env var preserves the override', async () => {
    await runSeed();

    const row = getDb()
      .prepare("SELECT specs FROM assets WHERE id = 'tron:USDT'")
      .get() as { specs: string } | undefined;

    expect(row).toBeDefined();
    const specs = JSON.parse(row!.specs);
    expect(specs.contract_address).toBe(TEST_CONTRACT);
  });

  it('also provisions tron:USDT tenant_hot_control ledger account when env var is set', () => {
    const hotWallet = getDb()
      .prepare("SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'tenant_hot' LIMIT 1")
      .get('tenant_default') as { id: string } | undefined;

    expect(hotWallet).toBeDefined();

    const account = getDb()
      .prepare(`
        SELECT id FROM ledger_accounts
        WHERE wallet_id = ? AND asset_id = 'tron:USDT' AND account_type = 'tenant_hot_control'
      `)
      .get(hotWallet!.id) as { id: string } | undefined;

    expect(account).toBeDefined();
  });
});
