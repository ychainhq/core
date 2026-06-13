import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/index';
import { BitcoinAdapter } from '../../chain-adapters/bitcoin/adapter';
import { btcNodeSelector } from '../../chain-adapters/registry';
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
  tron_xpub: string | null;
  tron_next_derivation_index: number;
  tron_confirmations_required: number;
  tron_sweep_threshold_sun: string | null;
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
    tron_xpub: row.tron_xpub ?? null,
    tron_next_derivation_index: row.tron_next_derivation_index ?? 0,
    tron_confirmations_required: row.tron_confirmations_required ?? 1,
    tron_sweep_threshold_sun: row.tron_sweep_threshold_sun ?? null,
  };
}

async function withConfig(tenant: Tenant): Promise<TenantWithConfig> {
  const db = getDbClient();
  const cfgRow = await db.get('SELECT * FROM tenant_configs WHERE tenant_id = ?', [tenant.id]);
  return {
    ...tenant,
    config: cfgRow ? mapConfig(cfgRow) : null,
  };
}

// Asset config types — add new chain types here when additional chains are supported.
export interface BtcAssetConfig {
  chain: 'bitcoin';
  hotAddress?: string;
  hotPubkeyHex?: string;
  coldAddress?: string;
  xpub?: string;
}

// Union type — extend with EthAssetConfig etc. when ETH is added.
export type AssetConfig = BtcAssetConfig;

interface TreasuryWalletOptions {
  role: 'tenant_hot' | 'tenant_cold';
  address: string;
  pubkeyHex?: string;
  addressRole: 'treasury_hot' | 'treasury_cold';
  walletName: string;
  accountType: 'tenant_hot_control' | 'tenant_cold_control';
  accountName: string;
}

async function upsertTreasuryWalletRows(tenantId: string, opts: TreasuryWalletOptions): Promise<void> {
  const db = getDbClient();
  const chainId = 'bitcoin';
  const assetId = 'bitcoin:BTC';
  const now = new Date().toISOString();

  let wallet = await db.get(
    'SELECT * FROM wallets WHERE tenant_id = ? AND wallet_role = ?',
    [tenantId, opts.role]
  ) as any;

  if (!wallet) {
    wallet = await walletsService.create(tenantId, {
      name: opts.walletName,
      type: 'external_signer',
      walletRole: opts.role,
    });
    await ledgerService.createAccount(tenantId, {
      walletId: wallet.id,
      chainId,
      assetId,
      accountType: opts.accountType,
      name: opts.accountName,
    });
  }

  const existingAddr = await db.get<{ id: string; status: string }>(
    'SELECT id, status FROM addresses WHERE wallet_id = ? AND address = ?',
    [wallet.id, opts.address]
  );

  if (existingAddr) {
    if (existingAddr.status !== 'active') {
      await db.run("UPDATE addresses SET status = 'active', updated_at = ? WHERE id = ?",
        [now, existingAddr.id]);
    }
    await db.run("UPDATE addresses SET status = 'replaced', updated_at = ? WHERE wallet_id = ? AND status = 'active' AND id != ?",
      [now, wallet.id, existingAddr.id]);
  } else {
    await db.run("UPDATE addresses SET status = 'replaced', updated_at = ? WHERE wallet_id = ? AND status = 'active'",
      [now, wallet.id]);
    await addressesService.addToWallet(tenantId, wallet.id, {
      chain: 'bitcoin',
      address: opts.address,
      label: opts.role,
      addressRole: opts.addressRole,
    });
  }
}

export const tenantsService = {
  /**
   * Provision LWallets for all enabled assets.
   * Call after create() completes. Idempotent per-step.
   * BTC is always provisioned regardless of the assets array.
   */
  async provision(tenantId: string, assets: AssetConfig[]): Promise<void> {
    const btcAsset = assets.find((a): a is BtcAssetConfig => a.chain === 'bitcoin');
    if (!btcAsset) throw new ValidationError('BTC asset config with hotAddress is required');

    await tenantsService.provisionBtcLWallets(tenantId, btcAsset);

    if (btcAsset.xpub) {
      await tenantsService.updateConfig(tenantId, { btcXpub: btcAsset.xpub });
    }
  },

  /**
   * Find-or-create a treasury wallet (tenant_hot or tenant_cold) and set the given address
   * as the active address. Idempotent: re-activates the address if already present.
   * Supersedes any previously active addresses in the wallet (status → 'replaced').
   */
  async upsertTreasuryWallet(
    tenantId: string,
    opts: TreasuryWalletOptions
  ): Promise<void> {
    const adapter = new BitcoinAdapter(btcNodeSelector);
    if (!adapter.isValidAddress(opts.address)) {
      throw new ValidationError(`Invalid bitcoin address: ${opts.address}`);
    }

    await upsertTreasuryWalletRows(tenantId, opts);
  },

  /**
   * Provision LWallets in the chain-api DB for the BTC chain.
   * Always creates customer_deposits. Creates tenant_hot / tenant_cold when
   * the respective address is provided.
   */
  async provisionBtcLWallets(tenantId: string, asset: BtcAssetConfig): Promise<void> {
    const adapter = new BitcoinAdapter(btcNodeSelector);

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
    const depositsWallet = await walletsService.create(tenantId, {
      name: 'Customer Deposits (BTC)',
      type: 'watch_only',
      walletRole: 'customer_deposits',
    });
    await ledgerService.createAccount(tenantId, {
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
        pubkeyHex: asset.hotPubkeyHex,
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

    if (hotWalletOpts) await upsertTreasuryWalletRows(tenantId, hotWalletOpts);
    if (coldWalletOpts) await upsertTreasuryWalletRows(tenantId, coldWalletOpts);

    // Tenant-level operational accounts
    await ledgerService.createAccount(tenantId, {
      chainId,
      assetId,
      accountType: 'sweep_in_transit',
      name: 'Sweep In Transit (BTC)',
    });
    await ledgerService.createAccount(tenantId, {
      chainId,
      assetId,
      accountType: 'network_fee_expense',
      name: 'Network Fee Expense (BTC)',
    });

  },

  async create(input: { name: string; metadata?: Record<string, unknown> }): Promise<TenantWithConfig> {
    const db = getDbClient();
    const id = `tenant_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    await db.run(`
      INSERT INTO tenants (id, name, status, metadata, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?)
    `, [id, input.name, input.metadata ? JSON.stringify(input.metadata) : null, now, now]);

    await db.run(`
      INSERT INTO tenant_configs (tenant_id, btc_confirmations_required, btc_finality_confirmations,
        custody_mode, withdrawal_mode, daily_withdrawal_limit_sats, per_tx_limit_sats, updated_at)
      VALUES (?, 1, 6, 'external_signer', 'external_signer', NULL, NULL, ?)
    `, [id, now]);

    return tenantsService.getById(id);
  },

  async list(input: { limit?: number; cursor?: string; status?: string } = {}): Promise<{
    data: TenantWithConfig[];
    nextCursor: string | null;
  }> {
    const db = getDbClient();
    const limit = Math.min(input.limit ?? 20, 100);
    let query = 'SELECT * FROM tenants WHERE 1=1';
    const params: unknown[] = [];

    if (input.status) { query += ' AND status = ?'; params.push(input.status); }
    if (input.cursor) { query += ' AND id > ?'; params.push(input.cursor); }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = await db.all(query, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: await Promise.all(items.map((r) => withConfig(mapTenant(r)))),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  async getById(id: string): Promise<TenantWithConfig> {
    const db = getDbClient();
    const row = await db.get('SELECT * FROM tenants WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Tenant', id);
    return withConfig(mapTenant(row));
  },

  async update(
    id: string,
    input: { name?: string; status?: string; metadata?: Record<string, unknown> }
  ): Promise<TenantWithConfig> {
    const db = getDbClient();
    await tenantsService.getById(id); // 404 guard
    const now = new Date().toISOString();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name); }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status); }
    if (input.metadata !== undefined) { sets.push('metadata = ?'); params.push(JSON.stringify(input.metadata)); }
    if (sets.length === 0) return tenantsService.getById(id);

    sets.push('updated_at = ?');
    params.push(now, id);
    await db.run(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, params);
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
      btcHotPubkeyHex?: string;
      btcColdAddress?: string;
      tronXpub?: string | null;
      tronConfirmationsRequired?: number;
      tronSweepThresholdSun?: string | null;
    }
  ): Promise<TenantConfig> {
    const db = getDbClient();
    await tenantsService.getById(tenantId); // 404 guard
    const now = new Date().toISOString();

    const existing = await db.get<TenantConfig>(
      'SELECT * FROM tenant_configs WHERE tenant_id = ?',
      [tenantId]
    );

    if (!existing) {
      await db.run(`
        INSERT INTO tenant_configs (tenant_id, btc_confirmations_required, btc_finality_confirmations,
          custody_mode, withdrawal_mode, daily_withdrawal_limit_sats, per_tx_limit_sats,
          btc_xpub, btc_sweep_threshold_sats, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        tenantId,
        input.btcConfirmationsRequired ?? 1,
        input.btcFinalityConfirmations ?? 6,
        input.custodyMode ?? 'external_signer',
        input.withdrawalMode ?? 'external_signer',
        input.dailyWithdrawalLimitSats ?? null,
        input.perTxLimitSats ?? null,
        input.btcXpub ?? null,
        input.btcSweepThresholdSats ?? '100000',
        now,
      ]);
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
      if ('tronXpub' in input) { sets.push('tron_xpub = ?'); params.push(input.tronXpub ?? null); }
      if (input.tronConfirmationsRequired !== undefined) { sets.push('tron_confirmations_required = ?'); params.push(input.tronConfirmationsRequired); }
      if ('tronSweepThresholdSun' in input) { sets.push('tron_sweep_threshold_sun = ?'); params.push(input.tronSweepThresholdSun ?? null); }

      if (sets.length > 0) {
        sets.push('updated_at = ?');
        params.push(now, tenantId);
        await db.run(`UPDATE tenant_configs SET ${sets.join(', ')} WHERE tenant_id = ?`, params);
      }
    }

    if (input.btcHotAddress) {
      await tenantsService.upsertTreasuryWallet(tenantId, {
        role: 'tenant_hot',
        address: input.btcHotAddress,
        pubkeyHex: input.btcHotPubkeyHex,
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

    const row = await db.get('SELECT * FROM tenant_configs WHERE tenant_id = ?', [tenantId]);
    return mapConfig(row);
  },

  async getConfirmationsRequired(tenantId: string): Promise<number> {
    const db = getDbClient();
    const row = await db.get<{ btc_confirmations_required: number }>(
      'SELECT btc_confirmations_required FROM tenant_configs WHERE tenant_id = ?',
      [tenantId]
    );
    return row?.btc_confirmations_required ?? config.BTC_DEFAULT_CONFIRMATIONS;
  },

  async getTronConfirmationsRequired(tenantId: string): Promise<number> {
    const db = getDbClient();
    const row = await db.get<{ tron_confirmations_required: number }>(
      'SELECT tron_confirmations_required FROM tenant_configs WHERE tenant_id = ?',
      [tenantId]
    );
    return row?.tron_confirmations_required ?? config.TRON_DEFAULT_CONFIRMATIONS;
  },

  async getTronXpub(tenantId: string): Promise<string | null> {
    const db = getDbClient();
    const row = await db.get<{ tron_xpub: string | null }>(
      'SELECT tron_xpub FROM tenant_configs WHERE tenant_id = ?',
      [tenantId]
    );
    return row?.tron_xpub ?? null;
  },

  async allocateTronDerivationIndex(tenantId: string): Promise<number> {
    const db = getDbClient();
    const row = await db.get<{ tron_next_derivation_index: number }>(
      'SELECT tron_next_derivation_index FROM tenant_configs WHERE tenant_id = ?',
      [tenantId]
    );
    if (!row) throw new NotFoundError('TenantConfig', tenantId);
    const index = row.tron_next_derivation_index;
    await db.run(
      'UPDATE tenant_configs SET tron_next_derivation_index = tron_next_derivation_index + 1, updated_at = ? WHERE tenant_id = ?',
      [new Date().toISOString(), tenantId]
    );
    return index;
  },

  async generateApiKey(tenantId: string, name: string): Promise<{ keyId: string; rawKey: string }> {
    const db = getDbClient();
    await tenantsService.getById(tenantId); // 404 guard

    const rawKey = `cak_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyId = `apikey_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    const existing = await db.get('SELECT id FROM api_keys WHERE key_hash = ?', [keyHash]);
    if (existing) throw new ConflictError('API key collision — please retry');

    await db.run(`
      INSERT INTO api_keys (id, tenant_id, key_hash, name, is_active, last_used_at, created_at, expires_at)
      VALUES (?, ?, ?, ?, 1, NULL, ?, NULL)
    `, [keyId, tenantId, keyHash, name, now]);

    return { keyId, rawKey };
  },
};
