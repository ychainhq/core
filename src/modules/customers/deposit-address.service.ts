import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import crypto from 'crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { getDbClient } from '../../db/client';
import { ValidationError, NotFoundError } from '../../shared/errors/index';
import { config } from '../../config/index';
import { logger } from '../../shared/logging/index';
import { tenantsService } from '../tenants/tenants.service';

// Initialize ECC library (idempotent)
try { bitcoin.initEccLib(ecc); } catch { /* already initialized */ }
const bip32 = BIP32Factory(ecc);

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf: Buffer): string {
  let num = BigInt('0x' + buf.toString('hex'));
  let encoded = '';
  while (num > 0n) {
    encoded = BASE58_ALPHABET[Number(num % 58n)]! + encoded;
    num = num / 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    encoded = BASE58_ALPHABET[0]! + encoded;
  }
  return encoded;
}

function tronAddressFromCompressedPubkey(compressedPubkey: Uint8Array): string {
  const uncompressed = ecc.pointCompress(compressedPubkey, false); // 65 bytes: 04 || x || y
  const hash = keccak_256(uncompressed.slice(1)); // keccak256 of 64-byte x||y
  const addressBytes = Buffer.allocUnsafe(21);
  addressBytes[0] = 0x41; // TRON mainnet prefix
  Buffer.from(hash).copy(addressBytes, 1, 12); // last 20 bytes of keccak256
  const checksum = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(addressBytes).digest())
    .digest()
    .subarray(0, 4);
  return base58Encode(Buffer.concat([addressBytes, checksum]));
}

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
  chain: 'bitcoin' | 'tron';
  customerId: string;
  walletId: string;
}

export const depositAddressService = {
  /**
   * Derive the next deposit address for a customer using the tenant's xpub.
   * Atomically increments the derivation index in tenant_configs.
   * Registers the address in the customer_deposits LWallet and watched_addresses.
   *
   * Derivation path: m/0/{index} (external chain of account-level xpub)
   */
  async generateForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<DepositAddressResult> {
    const db = getDbClient();

    // Load tenant config
    const cfg = await db.get<{ btc_xpub: string | null; btc_next_derivation_index: number }>(
      'SELECT btc_xpub, btc_next_derivation_index FROM tenant_configs WHERE tenant_id = ?',
      [tenantId]
    );

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
    const depositsWallet = await db.get<{ id: string }>(
      "SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits' LIMIT 1",
      [tenantId]
    );

    if (!depositsWallet) {
      throw new NotFoundError('Wallet', 'customer_deposits');
    }

    // Atomically claim the next index
    const index = cfg.btc_next_derivation_index;
    await db.run(
      'UPDATE tenant_configs SET btc_next_derivation_index = btc_next_derivation_index + 1, updated_at = ? WHERE tenant_id = ?',
      [new Date().toISOString(), tenantId]
    );

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
      await db.run(
        `INSERT INTO addresses (id, tenant_id, wallet_id, chain_id, address, label, address_type,
          address_role, customer_id, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'bitcoin', ?, ?, 'p2wpkh', 'customer_deposit', ?, 'active',
          ?, ?, ?)`,
        [
          addrId,
          tenantId,
          depositsWallet.id,
          address,
          `deposit-${customerId}-${index}`,
          customerId,
          JSON.stringify({ derivationPath, derivationIndex: index }),
          now,
          now,
        ]
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
      await db.run(
        `INSERT INTO watched_addresses
          (id, tenant_id, chain_id, address, wallet_id, customer_id, label, events, is_active, created_at, updated_at)
        VALUES (?, ?, 'bitcoin', ?, ?, ?, ?, '["incoming"]', 1, ?, ?)
        ON CONFLICT DO NOTHING`,
        [
          monitorId,
          tenantId,
          address,
          depositsWallet.id,
          customerId,
          `customer-${customerId}-deposit`,
          now,
          now,
        ]
      );
    } catch (err) {
      logger.warn('Failed to add address to watched_addresses (non-fatal)', { address, tenantId, err });
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

  /**
   * Derive the next TRON/USDT deposit address for a customer using the tenant's tron_xpub.
   * Atomically increments tron_next_derivation_index in tenant_configs.
   * Derivation path: m/0/{index} (external chain of account-level xpub, SLIP44 coin_type=195).
   * Address encoding: keccak256(uncompressed_pubkey[1:])[12:] → prepend 0x41 → Base58Check.
   */
  async generateTronForCustomer(
    tenantId: string,
    customerId: string
  ): Promise<DepositAddressResult> {
    const db = getDbClient();

    const tronXpub = await tenantsService.getTronXpub(tenantId);
    if (!tronXpub) {
      throw new ValidationError(
        'Tenant has no tron_xpub configured. Set it via PATCH /admin/v1/tenants/:id/config with tronXpub.'
      );
    }

    let rootNode: ReturnType<typeof bip32.fromBase58>;
    try {
      rootNode = bip32.fromBase58(tronXpub, bitcoin.networks.bitcoin);
    } catch {
      throw new ValidationError('Stored tron_xpub is invalid. Update it via PATCH /admin/v1/tenants/:id/config.');
    }

    const depositsWallet = await db.get<{ id: string }>(
      "SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits' LIMIT 1",
      [tenantId]
    );
    if (!depositsWallet) {
      throw new NotFoundError('Wallet', 'customer_deposits');
    }

    const index = await tenantsService.allocateTronDerivationIndex(tenantId);
    const child = rootNode.derive(0).derive(index);
    const address = tronAddressFromCompressedPubkey(child.publicKey);
    const derivationPath = `m/0/${index}`;

    const now = new Date().toISOString();
    const addrId = `addr_${crypto.randomBytes(8).toString('hex')}`;

    try {
      await db.run(
        `INSERT INTO addresses (id, tenant_id, wallet_id, chain_id, address, label, address_type,
          address_role, customer_id, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'tron', ?, ?, 'tron_account', 'customer_deposit', ?, 'active', ?, ?, ?)`,
        [
          addrId,
          tenantId,
          depositsWallet.id,
          address,
          `tron-deposit-${customerId}-${index}`,
          customerId,
          JSON.stringify({ derivationPath, derivationIndex: index }),
          now,
          now,
        ]
      );
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE constraint')) {
        logger.warn('Derived TRON address already registered, continuing', { address, tenantId, customerId });
      } else {
        throw err;
      }
    }

    const monitorId = `mon_${crypto.randomBytes(8).toString('hex')}`;
    try {
      await db.run(
        `INSERT INTO watched_addresses
          (id, tenant_id, chain_id, address, wallet_id, customer_id, label, events, is_active, created_at, updated_at)
        VALUES (?, ?, 'tron', ?, ?, ?, ?, '["incoming"]', 1, ?, ?)
        ON CONFLICT DO NOTHING`,
        [
          monitorId,
          tenantId,
          address,
          depositsWallet.id,
          customerId,
          `tron-customer-${customerId}-deposit`,
          now,
          now,
        ]
      );
    } catch (err) {
      logger.warn('Failed to add TRON address to watched_addresses (non-fatal)', { address, tenantId, err });
    }

    return {
      address,
      derivationPath,
      derivationIndex: index,
      chain: 'tron',
      customerId,
      walletId: depositsWallet.id,
    };
  },
};
