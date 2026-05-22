import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/index';
import { BitcoinAdapter } from '../../chain-adapters/bitcoin/adapter';
import { logger } from '../../shared/logging/index';
import { config } from '../../config/index';
import { toUnixTs } from '../../shared/time/index';
import { walletsService } from '../wallets/wallets.service';
import { addressesService } from '../addresses/addresses.service';
import { ledgerService } from '../ledger/ledger.service';

export interface Tenant {
  id: string;
  name: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

export interface TenantConfig {
  tenant_id: string;
  btc_confirmations_required: number;
  btc_finality_confirmations: number;
  custody_mode: string;
  withdrawal_mode: string;
  daily_withdrawal_limit_sats: string | null;
  per_tx_limit_sats: string | null;
  btc_xpub: string | null;
  btc_next_derivation_index: number;
  btc_sweep_threshold_sats: string;
  customer_session_ttl_seconds: number;
  /** HMAC-SHA256 secret used to sign/verify X-Actor-Token JWTs issued by the tenant. */
  actor_token_secret: string | null;
  updated_at: number;
}

export interface TenantWithConfig extends Tenant {
  config: TenantConfig | null;
}

function mapTenant(row: any): Tenant {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    created_at: toUnixTs(row.created_at),
    updated_at: toUnixTs(row.updated_at),
  };
}

function mapConfig(row: any): TenantConfig {
  return {
    ...row,
    updated_at: toUnixTs(row.updated_at),
    customer_session_ttl_seconds: row.customer_session_ttl_seconds ?? 3600,
    actor_token_secret: row.actor_token_secret ?? null,
  };
}

function withConfig(tenant: Tenant): TenantWithConfig {
  const db = getDb();
  const cfgRow = db
    .prepare('SELECT * FROM tenant_configs WHERE tenant_id = ?')
    .get(tenant.id);
  return {
    ...tenant,
    config: cfgRow ? mapConfig(cfgRow) : null,
  };
}

// Asset config types — add new chain types here when additional chains are supported.
export interface BtcAssetConfig {
  chain: 'bitcoin';
  hotAddress?: string;
  coldAddress?: string;
  xpub?: string;
}

// Union type — extend with EthAssetConfig etc. when ETH is added.
export type AssetConfig = BtcAssetConfig;

interface TreasuryWalletOptions {
  role: 'tenant_hot' | 'tenant_cold';
  address: string;
  addressRole: 'treasury_hot' | 'treasury_cold';
  walletName: string;
  accountType: 'tenant_hot_control' | 'tenant_cold_control';
  accountName: string;
}

function upsertTreasuryWalletRows(tenantId: string, opts: TreasuryWalletOptions): void {
  const db = getDb();
  const chainId = 'bitcoin';
  const assetId = 'bitcoin:BTC';
  const now = new Date().toISOString();

  let wallet = db
    .prepare('SELECT * FROM wallets WHERE tenant_id = ? AND wallet_role = ?')
    .get(tenantId, opts.role) as any;

  if (!wallet) {
    wallet = walletsService.create(tenantId, {
      name: opts.walletName,
      type: 'external_signer',
      walletRole: opts.role,
    });
    ledgerService.createAccount(tenantId, {
      walletId: wallet.id,
      chainId,
      assetId,
      accountType: opts.accountType,
      name: opts.accountName,
    });
  }

  const existingAddr = db
    .prepare('SELECT id, status FROM addresses WHERE wallet_id = ? AND address = ?')
    .get(wallet.id, opts.address) as { id: string; status: string } | undefined;

  if (existingAddr) {
    if (existingAddr.status !== 'active') {
      db.prepare("UPDATE addresses SET status = 'active', updated_at = ? WHERE id = ?")
        .run(now, existingAddr.id);
    }
    db.prepare("UPDATE addresses SET status = 'replaced', updated_at = ? WHERE wallet_id = ? AND status = 'active' AND id != ?")
      .run(now, wallet.id, existingAddr.id);
  } else {
    db.prepare("UPDATE addresses SET status = 'replaced', updated_at = ? WHERE wallet_id = ? AND status = 'active'")
      .run(now, wallet.id);
    addressesService.addToWallet(tenantId, wallet.id, {
      chain: 'bitcoin',
      address: opts.address,
      label: opts.role,
      addressRole: opts.addressRole,
    });
  }
}

async function importTreasuryAddress(tenantId: string, opts: TreasuryWalletOptions): Promise<void> {
  if (!config.BITCOIN_CORE_PROVISIONING_ENABLED) {
    logger.debug('Skipping Bitcoin Core treasury address import', {
      tenantId,
      address: opts.address,
      role: opts.role,
    });
    return;
  }

  const adapter = new BitcoinAdapter();
  try {
    await adapter.importAddressForTenant(opts.address, tenantId, opts.role);
  } catch (err) {
    logger.warn('Failed to import treasury address into BTC Core FWallet (non-fatal)', {
      tenantId, address: opts.address, role: opts.role, err,
    });
  }
}

export const tenantsService = {
  /**
   * Provision FWallet + LWallets for all enabled assets.
   * Call after create() completes. Idempotent per-step.
   * BTC is always provisioned in MVP regardless of the assets array.
   */
  async provision(tenantId: string, assets: AssetConfig[]): Promise<void> {
    const btcAsset = assets.find((a): a is BtcAssetConfig => a.chain === 'bitcoin');
    if (!btcAsset) throw new ValidationError('BTC asset config with hotAddress is required');

    // BTC: provision FWallet first (addresses are imported into it below)
    await tenantsService.provisionBitcoinWallet(tenantId);
    await tenantsService.provisionBtcLWallets(tenantId, btcAsset);

    // Store xpub in config if provided at onboarding time
    if (btcAsset.xpub) {
      await tenantsService.updateConfig(tenantId, { btcXpub: btcAsset.xpub });
    }

    // Future: for ETH — no FWallet, only LWallets
  },

  /**
   * Provision the Bitcoin Core watch-only FWallet for a tenant.
   * Idempotent: loads the existing wallet if it was already created.
   * Non-fatal: logs a warning if Bitcoin Core is unavailable so that the DB
   * tenant record is always created. The FWallet will be re-provisioned on
   * next startup or via the adapter directly.
   */
  async provisionBitcoinWallet(tenantId: string): Promise<void> {
    if (!config.BITCOIN_CORE_PROVISIONING_ENABLED) {
      logger.debug('Skipping Bitcoin Core FWallet provisioning for tenant', { tenantId });
      return;
    }

    const adapter = new BitcoinAdapter();
    try {
      await adapter.provisionTenantWallet(tenantId);
    } catch (err) {
      logger.warn('Could not provision Bitcoin Core FWallet for tenant (Bitcoin Core may be unavailable)', { tenantId, err });
    }
  },

  /**
   * Find-or-create a treasury wallet (tenant_hot or tenant_cold), set the given address
   * as the active address, and import it into the Bitcoin Core FWallet.
   * Idempotent: re-activates the address if it is already in the wallet.
   * Supersedes any previously active addresses in the wallet (status → 'replaced').
   */
  async upsertTreasuryWallet(
    tenantId: string,
    opts: TreasuryWalletOptions
  ): Promise<void> {
    const adapter = new BitcoinAdapter();
    if (!adapter.isValidAddress(opts.address)) {
      throw new ValidationError(`Invalid bitcoin address: ${opts.address}`);
    }

    upsertTreasuryWalletRows(tenantId, opts);
    await importTreasuryAddress(tenantId, opts);
  },

  /**
   * Provision LWallets in the chain-api DB for the BTC chain.
   * Always creates customer_deposits. Creates tenant_hot / tenant_cold when
   * the respective address is provided, and imports them into the FWallet.
   */
  async provisionBtcLWallets(tenantId: string, asset: BtcAssetConfig): Promise<void> {
    const adapter = new BitcoinAdapter();

    // Validate addresses upfront before any DB writes
    if (asset.hotAddress && !adapter.isValidAddress(asset.hotAddress)) {
      throw new ValidationError(`Invalid bitcoin hotAddress: ${asset.hotAddress}`);
    }
    if (asset.coldAddress && !adapter.isValidAddress(asset.coldAddress)) {
      throw new ValidationError(`Invalid bitcoin coldAddress: ${asset.coldAddress}`);
    }

    const chainId = 'bitcoin';
    const assetId = 'bitcoin:BTC';

    // Always create the customer_deposits LWallet (needed for deposit acceptance)
    const depositsWallet = walletsService.create(tenantId, {
      name: 'Customer Deposits (BTC)',
      type: 'watch_only',
      walletRole: 'customer_deposits',
    });
    ledgerService.createAccount(tenantId, {
      walletId: depositsWallet.id,
      chainId,
      assetId,
      accountType: 'customer_available',
      name: 'Customer Deposits Aggregate (BTC)',
    });

    const hotWalletOpts: TreasuryWalletOptions | null = asset.hotAddress
      ? {
        role: 'tenant_hot',
        address: asset.hotAddress,
        addressRole: 'treasury_hot',
        walletName: 'Tenant Hot Wallet (BTC)',
        accountType: 'tenant_hot_control',
        accountName: 'Tenant Hot Control (BTC)',
      }
      : null;

    const coldWalletOpts: TreasuryWalletOptions | null = asset.coldAddress
      ? {
        role: 'tenant_cold',
        address: asset.coldAddress,
        addressRole: 'treasury_cold',
        walletName: 'Tenant Cold Wallet (BTC)',
        accountType: 'tenant_cold_control',
        accountName: 'Tenant Cold Control (BTC)',
      }
      : null;

    if (hotWalletOpts) upsertTreasuryWalletRows(tenantId, hotWalletOpts);
    if (coldWalletOpts) upsertTreasuryWalletRows(tenantId, coldWalletOpts);

    // Tenant-level operational accounts (not linked to specific wallets)
    ledgerService.createAccount(tenantId, {
      chainId,
      assetId,
      accountType: 'sweep_in_transit',
      name: 'Sweep In Transit (BTC)',
    });
    ledgerService.createAccount(tenantId, {
      chainId,
      assetId,
      accountType: 'network_fee_expense',
      name: 'Network Fee Expense (BTC)',
    });

    if (hotWalletOpts) await importTreasuryAddress(tenantId, hotWalletOpts);
    if (coldWalletOpts) await importTreasuryAddress(tenantId, coldWalletOpts);
  },

  create(input: { name: string; metadata?: Record<string, unknown> }): TenantWithConfig {
    const db = getDb();
    const id = `tenant_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO tenants (id, name, status, metadata, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?)
    `).run(id, input.name, input.metadata ? JSON.stringify(input.metadata) : null, now, now);

    db.prepare(`
      INSERT INTO tenant_configs (tenant_id, btc_confirmations_required, btc_finality_confirmations,
        custody_mode, withdrawal_mode, daily_withdrawal_limit_sats, per_tx_limit_sats, updated_at)
      VALUES (?, 1, 6, 'external_signer', 'external_signer', NULL, NULL, ?)
    `).run(id, now);

    return tenantsService.getById(id);
  },

  list(input: { limit?: number; cursor?: string; status?: string } = {}): {
    data: TenantWithConfig[];
    nextCursor: string | null;
  } {
    const db = getDb();
    const limit = Math.min(input.limit ?? 20, 100);
    let query = 'SELECT * FROM tenants WHERE 1=1';
    const params: unknown[] = [];

    if (input.status) { query += ' AND status = ?'; params.push(input.status); }
    if (input.cursor) { query += ' AND id > ?'; params.push(input.cursor); }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map((r) => withConfig(mapTenant(r))),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  },

  getById(id: string): TenantWithConfig {
    const db = getDb();
    const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Tenant', id);
    return withConfig(mapTenant(row));
  },

  update(
    id: string,
    input: { name?: string; status?: string; metadata?: Record<string, unknown> }
  ): TenantWithConfig {
    const db = getDb();
    tenantsService.getById(id); // 404 guard
    const now = new Date().toISOString();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name); }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status); }
    if (input.metadata !== undefined) { sets.push('metadata = ?'); params.push(JSON.stringify(input.metadata)); }
    if (sets.length === 0) return tenantsService.getById(id);

    sets.push('updated_at = ?');
    params.push(now, id);
    db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return tenantsService.getById(id);
  },

  async updateConfig(
    tenantId: string,
    input: {
      btcConfirmationsRequired?: number;
      btcFinalityConfirmations?: number;
      custodyMode?: string;
      withdrawalMode?: string;
      dailyWithdrawalLimitSats?: string | null;
      perTxLimitSats?: string | null;
      btcXpub?: string | null;
      btcSweepThresholdSats?: string;
      customerSessionTtlSeconds?: number;
      actorTokenSecret?: string | null;
      btcHotAddress?: string;
      btcColdAddress?: string;
    }
  ): Promise<TenantConfig> {
    const db = getDb();
    tenantsService.getById(tenantId); // 404 guard
    const now = new Date().toISOString();

    const existing = db
      .prepare('SELECT * FROM tenant_configs WHERE tenant_id = ?')
      .get(tenantId) as TenantConfig | undefined;

    if (!existing) {
      db.prepare(`
        INSERT INTO tenant_configs (tenant_id, btc_confirmations_required, btc_finality_confirmations,
          custody_mode, withdrawal_mode, daily_withdrawal_limit_sats, per_tx_limit_sats,
          btc_xpub, btc_sweep_threshold_sats, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tenantId,
        input.btcConfirmationsRequired ?? 1,
        input.btcFinalityConfirmations ?? 6,
        input.custodyMode ?? 'external_signer',
        input.withdrawalMode ?? 'external_signer',
        input.dailyWithdrawalLimitSats ?? null,
        input.perTxLimitSats ?? null,
        input.btcXpub ?? null,
        input.btcSweepThresholdSats ?? '100000',
        now
      );
    } else {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (input.btcConfirmationsRequired !== undefined) { sets.push('btc_confirmations_required = ?'); params.push(input.btcConfirmationsRequired); }
      if (input.btcFinalityConfirmations !== undefined) { sets.push('btc_finality_confirmations = ?'); params.push(input.btcFinalityConfirmations); }
      if (input.custodyMode !== undefined) { sets.push('custody_mode = ?'); params.push(input.custodyMode); }
      if (input.withdrawalMode !== undefined) { sets.push('withdrawal_mode = ?'); params.push(input.withdrawalMode); }
      if ('dailyWithdrawalLimitSats' in input) { sets.push('daily_withdrawal_limit_sats = ?'); params.push(input.dailyWithdrawalLimitSats ?? null); }
      if ('perTxLimitSats' in input) { sets.push('per_tx_limit_sats = ?'); params.push(input.perTxLimitSats ?? null); }
      if ('btcXpub' in input) { sets.push('btc_xpub = ?'); params.push(input.btcXpub ?? null); }
      if (input.btcSweepThresholdSats !== undefined) { sets.push('btc_sweep_threshold_sats = ?'); params.push(input.btcSweepThresholdSats); }
      if (input.customerSessionTtlSeconds !== undefined) { sets.push('customer_session_ttl_seconds = ?'); params.push(input.customerSessionTtlSeconds); }
      if ('actorTokenSecret' in input) { sets.push('actor_token_secret = ?'); params.push(input.actorTokenSecret ?? null); }

      if (sets.length > 0) {
        sets.push('updated_at = ?');
        params.push(now, tenantId);
        db.prepare(`UPDATE tenant_configs SET ${sets.join(', ')} WHERE tenant_id = ?`).run(...params);
      }
    }

    if (input.btcHotAddress) {
      await tenantsService.upsertTreasuryWallet(tenantId, {
        role: 'tenant_hot',
        address: input.btcHotAddress,
        addressRole: 'treasury_hot',
        walletName: 'Tenant Hot Wallet (BTC)',
        accountType: 'tenant_hot_control',
        accountName: 'Tenant Hot Control (BTC)',
      });
    }

    if (input.btcColdAddress) {
      await tenantsService.upsertTreasuryWallet(tenantId, {
        role: 'tenant_cold',
        address: input.btcColdAddress,
        addressRole: 'treasury_cold',
        walletName: 'Tenant Cold Wallet (BTC)',
        accountType: 'tenant_cold_control',
        accountName: 'Tenant Cold Control (BTC)',
      });
    }

    const row = db.prepare('SELECT * FROM tenant_configs WHERE tenant_id = ?').get(tenantId);
    return mapConfig(row);
  },

  generateApiKey(tenantId: string, name: string): { keyId: string; rawKey: string } {
    const db = getDb();
    tenantsService.getById(tenantId); // 404 guard

    const rawKey = `cak_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyId = `apikey_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    const existing = db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(keyHash);
    if (existing) throw new ConflictError('API key collision — please retry');

    db.prepare(`
      INSERT INTO api_keys (id, tenant_id, key_hash, name, is_active, last_used_at, created_at, expires_at)
      VALUES (?, ?, ?, ?, 1, NULL, ?, NULL)
    `).run(keyId, tenantId, keyHash, name, now);

    return { keyId, rawKey };
  },
};
