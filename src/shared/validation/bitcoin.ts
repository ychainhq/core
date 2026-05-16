import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

// Initialize ECC library once — needed for Taproot (P2TR) address support.
// This is safe to call multiple times (idempotent).
try {
  bitcoin.initEccLib(ecc);
} catch {
  // Already initialized — safe to ignore
}

function getNetwork(network: string): bitcoin.Network {
  switch (network) {
    case 'mainnet':
      return bitcoin.networks.bitcoin;
    case 'testnet':
      return bitcoin.networks.testnet;
    case 'regtest':
      return bitcoin.networks.regtest;
    default:
      return bitcoin.networks.bitcoin;
  }
}

/**
 * Validate a Bitcoin address for a given network using bitcoinjs-lib.
 * This does NOT require an RPC call — purely local validation.
 * Supports P2PKH, P2SH, P2WPKH, P2WSH, P2TR.
 */
export function validateBitcoinAddress(address: string, network = 'mainnet'): boolean {
  if (!address || typeof address !== 'string') return false;
  try {
    const net = getNetwork(network);
    bitcoin.address.toOutputScript(address, net);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a raw transaction hex string by attempting to parse it.
 */
export function validateRawTransaction(hex: string): boolean {
  if (!hex || typeof hex !== 'string') return false;
  try {
    const buffer = Buffer.from(hex, 'hex');
    if (buffer.length === 0) return false;
    bitcoin.Transaction.fromBuffer(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a PSBT base64 string by attempting to parse it.
 */
export function validatePsbt(base64: string): boolean {
  if (!base64 || typeof base64 !== 'string') return false;
  try {
    bitcoin.Psbt.fromBase64(base64);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect Bitcoin address type by inspecting the output script pattern.
 * bitcoinjs-lib v6 does not export script template checkers directly;
 * we match on script length and opcode patterns.
 */
export function detectAddressType(address: string, network = 'mainnet'): string | null {
  if (!validateBitcoinAddress(address, network)) return null;
  try {
    const net = getNetwork(network);
    const script = bitcoin.address.toOutputScript(address, net);
    // P2PKH: OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG (25 bytes)
    if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[23] === 0x88 && script[24] === 0xac) {
      return 'p2pkh';
    }
    // P2SH: OP_HASH160 <20-byte-hash> OP_EQUAL (23 bytes)
    if (script.length === 23 && script[0] === 0xa9 && script[22] === 0x87) {
      return 'p2sh';
    }
    // P2WPKH: OP_0 <20-byte-hash> (22 bytes)
    if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) {
      return 'p2wpkh';
    }
    // P2WSH: OP_0 <32-byte-hash> (34 bytes)
    if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) {
      return 'p2wsh';
    }
    // P2TR: OP_1 <32-byte-x-only-pubkey> (34 bytes)
    if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
      return 'p2tr';
    }
    return 'unknown';
  } catch {
    return null;
  }
}
