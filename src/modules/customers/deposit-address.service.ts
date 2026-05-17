import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { getDb } from '../../db/sqlite';
import { ValidationError, NotFoundError } from '../../shared/errors/index';
import { BitcoinAdapter } from '../../chain-adapters/bitcoin/adapter';
import { config } from '../../config/index';
import { logger } from '../../shared/logging/index';

// Initialize ECC library (idempotent)
try { bitcoin.initEccLib(ecc); } catch { /* already initialized */ }
const bip32 = BIP32Factory(ecc);

function getBtcNetwork(): bitcoin.Network {
  switch (config.BITCOIN_NETWORK) {
    case 'testnet': return bitcoin.networks.testnet;
    case 'regtest': return bitcoin.networks.regtest;
    default:        return bitcoin.networks.bitcoin;
  }
}

/**
 * Validate that a string is a valid extended public key (xpub/tpub) for the
 * configured network. Returns false for ypub/zpub — tenants must provide xpub.
 */
export function validateXpub(xpub: string): boolean {
  if (!xpub || typeof xpub !== 'string') return false;
  try {
    bip32.fromBase58(xpub, getBtcNetwork());
    return true;
  } catch {
    return false;
  }
}

export interface DepositAddressResult {
  address: string;
  derivationPath: string;
  derivationIndex: number;
  chain: 'bitcoin';
  customerId: string;
  walletId: string;
}

export const depositAddressService = {
  /**
   * Derive the next deposit address for a customer using the tenant's xpub.
   * Atomically increments the derivation index in tenant_configs.
   * Registers the address in the customer_deposits LWallet and imports it
   * into Bitcoin Core FWallet (non-fatal on failure).
   *
   * Derivation path: m/0/{index} (external chain of account-level xpub)
   */
  async generateForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<DepositAddressResult> {
    const db = getDb();

    // Load tenant config
    const cfg = db
      .prepare('SELECT btc_xpub, btc_next_derivation_index FROM tenant_configs WHERE tenant_id = ?')
      .get(tenantId) as { btc_xpub: string | null; btc_next_derivation_index: number } | undefined;

    if (!cfg?.btc_xpub) {
      throw new ValidationError(
        'Tenant has no btc_xpub configured. Set it via PATCH /admin/v1/tenants/:id/config with btcXpub.'
      );
    }

    const network = getBtcNetwork();
    let rootNode: ReturnType<typeof bip32.fromBase58>;
    try {
      rootNode = bip32.fromBase58(cfg.btc_xpub, network);
    } catch {
      throw new ValidationError('Stored btc_xpub is invalid. Update it via PATCH /admin/v1/tenants/:id/config.');
    }

    // Find the customer_deposits LWallet for this tenant
    const depositsWallet = db
      .prepare("SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits' LIMIT 1")
      .get(tenantId) as { id: string } | undefined;

    if (!depositsWallet) {
      throw new NotFoundError('Wallet', 'customer_deposits');
    }

    // Atomically claim the next index
    const index = cfg.btc_next_derivation_index;
    db.prepare(
      'UPDATE tenant_configs SET btc_next_derivation_index = btc_next_derivation_index + 1, updated_at = ? WHERE tenant_id = ?'
    ).run(new Date().toISOString(), tenantId);

    // Derive address: m/0/{index}  (external chain)
    const child = rootNode.derive(0).derive(index);
    const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network });

    if (!address) {
      throw new Error(`BIP32 derivation produced no address at index ${index}`);
    }

    const derivationPath = `m/0/${index}`;

    // Register address in the customer_deposits LWallet, tagged to this customer
    const now = new Date().toISOString();
    const addrId = `addr_${require('crypto').randomBytes(8).toString('hex')}`;

    try {
      db.prepare(`
        INSERT INTO addresses (id, tenant_id, wallet_id, chain_id, address, label, address_type,
          address_role, customer_id, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'bitcoin', ?, ?, 'p2wpkh', 'customer_deposit', ?, 'active',
          ?, ?, ?)
      `).run(
        addrId,
        tenantId,
        depositsWallet.id,
        address,
        `deposit-${customerId}-${index}`,
        customerId,
        JSON.stringify({ derivationPath, derivationIndex: index }),
        now,
        now
      );
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint')) {
        // Address already exists (duplicate xpub derivation) — safe to continue
        logger.warn('Derived address already registered, continuing', { address, tenantId, customerId });
      } else {
        throw err;
      }
    }

    // Add to watched_addresses for deposit monitoring
    const monitorId = `mon_${require('crypto').randomBytes(8).toString('hex')}`;
    try {
      db.prepare(`
        INSERT OR IGNORE INTO watched_addresses
          (id, tenant_id, chain_id, address, wallet_id, customer_id, label, events, is_active, created_at, updated_at)
        VALUES (?, ?, 'bitcoin', ?, ?, ?, ?, '["incoming"]', 1, ?, ?)
      `).run(
        monitorId,
        tenantId,
        address,
        depositsWallet.id,
        customerId,
        `customer-${customerId}-deposit`,
        now,
        now
      );
    } catch (err) {
      logger.warn('Failed to add address to watched_addresses (non-fatal)', { address, tenantId, err });
    }

    // Import into Bitcoin Core FWallet (non-fatal)
    try {
      const adapter = new BitcoinAdapter();
      await adapter.importAddressForTenant(address, tenantId, 'customer_deposit');
    } catch (err) {
      logger.warn('Failed to import deposit address into BTC Core FWallet (non-fatal)', { address, tenantId, err });
    }

    return {
      address,
      derivationPath,
      derivationIndex: index,
      chain: 'bitcoin',
      customerId,
      walletId: depositsWallet.id,
    };
  },
};
