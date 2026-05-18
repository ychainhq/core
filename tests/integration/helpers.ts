import express from 'express';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { createApp } from '../../src/app';
import { runMigrations } from '../../src/db/migrate';
import { runSeed } from '../../src/db/seed';
import { closeDb } from '../../src/db/sqlite';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

export const TEST_API_KEY = 'test_api_key_integration_secret';
export const TEST_ADMIN_KEY = 'test_admin_key_integration_secret';
export const TEST_TENANT_ID = 'tenant_default';

export const AUTH = { Authorization: `Bearer ${TEST_API_KEY}` };
export const ADMIN_AUTH = { 'X-Admin-Key': TEST_ADMIN_KEY };

// Bitcoin addresses used in tests (all valid mainnet addresses)
export const ADDR_1 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'; // P2WPKH
export const ADDR_2 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // P2WPKH
export const ADDR_3 = 'bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c'; // P2WPKH
export const ADDR_LEGACY = '1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1';       // P2PKH (known valid mainnet)
export const ADDR_P2SH   = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';       // P2SH

// Counter starting at 200 to avoid overlap with xpub seed counters used in other test files.
let addrCounter = 200;

/**
 * Generates a unique valid mainnet P2WPKH address per call.
 * Use when a test needs a distinct address to avoid UNIQUE(chain_id, address) conflicts
 * but doesn't need to verify the exact address value.
 */
export function uniqueAddr(): string {
  const seed = Buffer.alloc(32, addrCounter++);
  const node = bip32.fromSeed(seed, bitcoin.networks.bitcoin);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(node.publicKey),
    network: bitcoin.networks.bitcoin,
  });
  return address!;
}

/**
 * Bootstrap an Express app backed by a fresh in-memory SQLite database.
 * Call once per test file (Jest isolates module registries between files).
 */
export function bootstrapApp(): express.Application {
  closeDb();     // reset any prior singleton so each file gets a fresh :memory: DB
  runMigrations();
  runSeed();
  return createApp();
}

/**
 * Tear down: close the SQLite singleton so the next test file starts fresh.
 * Call in afterAll() of each integration test file.
 */
export function teardownDb(): void {
  closeDb();
}
