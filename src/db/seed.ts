import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { getDb } from './sqlite';
import { runMigrations } from './migrate';
import { config } from '../config/index';
import { logger } from '../shared/logging/index';
import { BitcoinAdapter } from '../chain-adapters/bitcoin/adapter';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateApiKey(): string {
  return `cak_${crypto.randomBytes(24).toString('hex')}`;
}

function generateAdminKey(): string {
  return `aak_${crypto.randomBytes(24).toString('hex')}`;
}

export async function runSeed(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  logger.info('Running seed...');

  // 1. Upsert default tenant
  const tenantExists = db.prepare('SELECT id FROM tenants WHERE id = ?').get('tenant_default');
  if (!tenantExists) {
    db.prepare(`
      INSERT INTO tenants (id, name, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'tenant_default',
      config.TENANT_NAME,
      'active',
      JSON.stringify({}),
      now,
      now
    );
    logger.info('Inserted tenant: tenant_default');
  } else {
    logger.info('Tenant tenant_default already exists, skipping');
  }

  // 2. Upsert tenant_config for tenant_default
  const tenantConfigExists = db
    .prepare('SELECT tenant_id FROM tenant_configs WHERE tenant_id = ?')
    .get('tenant_default');
  if (!tenantConfigExists) {
    db.prepare(`
      INSERT INTO tenant_configs (tenant_id, btc_confirmations_required, btc_finality_confirmations, custody_mode, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'tenant_default',
      config.BTC_DEFAULT_CONFIRMATIONS,
      config.BTC_FINALITY_CONFIRMATIONS,
      'external_signer',
      now
    );
    logger.info('Inserted tenant_config for tenant_default');
  } else {
    db.prepare(`
      UPDATE tenant_configs
      SET btc_confirmations_required = ?, btc_finality_confirmations = ?, updated_at = ?
      WHERE tenant_id = ?
    `).run(
      config.BTC_DEFAULT_CONFIRMATIONS,
      config.BTC_FINALITY_CONFIRMATIONS,
      now,
      'tenant_default'
    );
    logger.info('Updated tenant_config for tenant_default');
  }

  // 2b. Generate BTC xpub for tenant_default if not yet set
  const cfgRow = db
    .prepare('SELECT btc_xpub FROM tenant_configs WHERE tenant_id = ?')
    .get('tenant_default') as { btc_xpub: string | null } | undefined;

  if (!cfgRow?.btc_xpub) {
    const network = config.BITCOIN_NETWORK === 'mainnet'
      ? bitcoin.networks.bitcoin
      : bitcoin.networks.testnet; // regtest shares BIP32 version bytes with testnet → tpub prefix

    try { bitcoin.initEccLib(ecc); } catch { /* already initialized */ }
    const bip32 = BIP32Factory(ecc);

    const entropy = crypto.randomBytes(32);
    const root = bip32.fromSeed(entropy, network);
    const coinType = config.BITCOIN_NETWORK === 'mainnet' ? 0 : 1;
    const accountNode = root.derivePath(`m/44'/${coinType}'/0'`);
    const xpub = accountNode.neutered().toBase58();
    const xprv = root.toBase58();

    db.prepare(
      "UPDATE tenant_configs SET btc_xpub = ?, updated_at = ? WHERE tenant_id = ?"
    ).run(xpub, now, 'tenant_default');

    logger.info('BTC xpub generated for tenant_default', { derivationPath: `m/44'/${coinType}'/0'` });

    console.log('');
    console.log('======================================================');
    console.log('GENERATED BTC DEV XPUB (stored in DB for tenant_default):');
    console.log('');
    console.log(`  BTC_DEV_XPUB=${xpub}`);
    console.log('');
    console.log('  BIP32 root private key (for signing daemon / regtest tests):');
    console.log(`  BTC_DEV_XPRV=${xprv}`);
    console.log('');
    console.log(`  Derivation path: m/44'/${coinType}'/0'`);
    console.log('  Customer deposit addresses derived at: m/0/{index} from xpub above');
    console.log('======================================================');
    console.log('');
  } else {
    logger.info('BTC xpub already set for tenant_default, skipping');
  }

  // 3. Upsert bitcoin chain
  const chainExists = db.prepare('SELECT id FROM chains WHERE id = ?').get('bitcoin');
  if (!chainExists) {
    db.prepare(`
      INSERT INTO chains (id, name, type, native_asset, chain_id, finality_type, is_enabled, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'bitcoin',
      'Bitcoin',
      'utxo',
      'BTC',
      null,
      'confirmations',
      1,
      JSON.stringify({ ticker: 'BTC', explorer: 'https://mempool.space' }),
      now,
      now
    );
    logger.info('Inserted chain: bitcoin');
  } else {
    logger.info('Chain bitcoin already exists, skipping');
  }

  // 4. Upsert BTC asset
  const assetExists = db.prepare('SELECT id FROM assets WHERE id = ?').get('bitcoin:BTC');
  if (!assetExists) {
    db.prepare(`
      INSERT INTO assets (id, chain_id, symbol, name, type, contract_address, decimals, is_enabled, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'bitcoin:BTC',
      'bitcoin',
      'BTC',
      'Bitcoin',
      'native',
      null,
      8,
      1,
      JSON.stringify({ coingeckoId: 'bitcoin' }),
      now,
      now
    );
    logger.info('Inserted asset: bitcoin:BTC');
  } else {
    logger.info('Asset bitcoin:BTC already exists, skipping');
  }

  // 5. Upsert API key with tenant_id
  let apiKey = config.API_KEY;
  let apiKeyGenerated = false;

  if (!apiKey) {
    apiKey = generateApiKey();
    apiKeyGenerated = true;
  }

  const keyHash = sha256(apiKey);

  const existingKey = db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(keyHash);
  if (!existingKey) {
    const keyId = `apikey_${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(`
      INSERT INTO api_keys (id, tenant_id, key_hash, name, is_active, last_used_at, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(keyId, 'tenant_default', keyHash, 'Default', 1, null, now, null);
    logger.info('API key created', { id: keyId });
  } else {
    logger.info('API key already exists, skipping');
  }

  // 6. Backfill existing rows without tenant_id
  const tables = [
    'wallets',
    'addresses',
    'watched_addresses',
    'payment_requests',
    'deposits',
    'transactions',
    'cached_utxos',
    'ledger_accounts',
    'ledger_entries',
    'webhooks',
    'webhook_deliveries',
  ];

  for (const table of tables) {
    const result = db
      .prepare(`UPDATE ${table} SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL`)
      .run();
    if (result.changes > 0) {
      logger.info(`Backfilled ${result.changes} rows in ${table} with tenant_id=tenant_default`);
    }
  }

  // 7. Admin key
  let adminKey = config.ADMIN_KEY;
  let adminKeyGenerated = false;

  if (!adminKey) {
    adminKey = generateAdminKey();
    adminKeyGenerated = true;
  }

  const adminKeyHash = sha256(adminKey);

  const existingAdminKey = db
    .prepare('SELECT id FROM admin_keys WHERE key_hash = ?')
    .get(adminKeyHash);
  if (!existingAdminKey) {
    const adminKeyId = `aak_${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(`
      INSERT INTO admin_keys (id, key_hash, name, is_active, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(adminKeyId, adminKeyHash, 'Default Admin', 1, now);
    logger.info('Admin key created', { id: adminKeyId });
  } else {
    logger.info('Admin key already exists, skipping');
  }

  if (apiKeyGenerated) {
    console.log('');
    console.log('======================================================');
    console.log('GENERATED API KEY (save this, it will not be shown again):');
    console.log('');
    console.log(`  API_KEY=${apiKey}`);
    console.log('');
    console.log('Add it to your .env file.');
    console.log('======================================================');
    console.log('');
  } else {
    logger.info('API key seed complete');
  }

  if (adminKeyGenerated) {
    console.log('');
    console.log('======================================================');
    console.log('GENERATED ADMIN KEY (save this, it will not be shown again):');
    console.log('');
    console.log(`  ADMIN_KEY=${adminKey}`);
    console.log('');
    console.log('Add it to your .env file.');
    console.log('======================================================');
    console.log('');
  } else {
    logger.info('Admin key seed complete');
  }

  // 8. Provision Bitcoin Core watch-only wallet for the default tenant
  try {
    const btcAdapter = new BitcoinAdapter();
    await btcAdapter.provisionTenantWallet('tenant_default');
    logger.info('Bitcoin Core wallet provisioned for tenant_default');
  } catch (err) {
    logger.warn('Could not provision Bitcoin Core wallet for tenant_default (Bitcoin Core may not be running)', { err });
  }
}

// Run if executed directly
if (require.main === module) {
  runMigrations();
  runSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
