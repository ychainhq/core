import crypto from 'crypto';
import * as ecc from 'tiny-secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

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

/**
 * Derive a TRON Base58Check address from a compressed secp256k1 public key.
 *
 * Algorithm:
 *   1. Uncompress pubkey → 65 bytes (04 || x || y)
 *   2. keccak256 of the 64-byte x||y (Ethereum-compatible, NOT NIST SHA-3)
 *   3. Take last 20 bytes of hash, prepend 0x41 (TRON mainnet prefix) → 21 bytes
 *   4. double-SHA256 checksum (4 bytes) → Base58Check encode
 */
export function tronAddressFromPublicKey(compressedPubkey: Uint8Array): string {
  const uncompressed = ecc.pointCompress(compressedPubkey, false);
  const hash = keccak_256(uncompressed.slice(1));
  const addressBytes = Buffer.allocUnsafe(21);
  addressBytes[0] = 0x41;
  Buffer.from(hash).copy(addressBytes, 1, 12);
  const checksum = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(addressBytes).digest())
    .digest()
    .subarray(0, 4);
  return base58Encode(Buffer.concat([addressBytes, checksum]));
}
