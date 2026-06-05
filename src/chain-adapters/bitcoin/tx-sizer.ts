/**
 * Bitcoin transaction vsize estimator for P2WPKH-input transactions.
 *
 * Segwit weight accounting:
 *   weight = 4 * (non-witness bytes) + 1 * (witness bytes)
 *   vsize  = ceil(weight / 4)
 *
 * P2WPKH input:
 *   base (non-witness): outpoint 36 + scriptSigLen 1 + scriptSig 0 + sequence 4 = 41 bytes → 164 weight
 *   witness:            stack_count 1 + sig_len 1 + sig 72 + pubkey_len 1 + pubkey 33 = 108 bytes → 108 weight
 *   vsize contribution: (164 + 108) / 4 = 68 vbytes
 *
 * Transaction overhead (segwit):
 *   version 4 + in_count 1 + out_count 1 + locktime 4 = 10 non-witness bytes → 40 weight
 *   marker 1 + flag 1 = 2 witness bytes → 2 weight
 *   vsize contribution: 42 / 4 = 10.5 vbytes
 */

export type AddressType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr';

export const P2WPKH_INPUT_VBYTES = 68;
export const TX_OVERHEAD_VBYTES = 10.5;

// Output = 8-byte value + 1-byte scriptLen + script
export const OUTPUT_VBYTES: Record<AddressType, number> = {
  p2pkh:  34, // script: OP_DUP OP_HASH160 <20B> OP_EQUALVERIFY OP_CHECKSIG (25 bytes)
  p2sh:   32, // script: OP_HASH160 <20B> OP_EQUAL (23 bytes)
  p2wpkh: 31, // script: OP_0 <20B> (22 bytes)
  p2wsh:  43, // script: OP_0 <32B> (34 bytes)
  p2tr:   43, // script: OP_1 <32B> (34 bytes)
};

/**
 * Detect Bitcoin address type from address string.
 *
 * Rules:
 *  - bc1p / tb1p / bcrt1p  → P2TR (bech32m, witness v1)
 *  - bc1q / tb1q / bcrt1q  → P2WPKH (≤44 chars) or P2WSH (>44 chars) (bech32, witness v0)
 *  - starts with 3 or 2    → P2SH (base58check)
 *  - everything else       → P2PKH (base58check, starts with 1/m/n)
 */
export function detectAddressType(address: string): AddressType {
  if (/^(bc1p|tb1p|bcrt1p)/i.test(address)) return 'p2tr';

  if (/^(bc1q|tb1q|bcrt1q)/i.test(address)) {
    // P2WPKH: 20-byte witness program → 42 chars (bc1q/tb1q) or 44 (bcrt1q)
    // P2WSH:  32-byte witness program → 62 chars (bc1q/tb1q) or 64 (bcrt1q)
    return address.length <= 44 ? 'p2wpkh' : 'p2wsh';
  }

  if (/^[32]/.test(address)) return 'p2sh';

  return 'p2pkh';
}

export interface TxSizeParams {
  inputCount: number; // all P2WPKH inputs (hot wallet outputs are always P2WPKH)
  outputs: Array<{ address: string }>;
}

/**
 * Estimate transaction vsize in virtual bytes.
 * Assumes all inputs are P2WPKH (hot wallet UTXOs).
 * Output sizes are computed from actual address types.
 */
export function estimateTxVsize(params: TxSizeParams): number {
  const outputVbytes = params.outputs.reduce(
    (sum, out) => sum + OUTPUT_VBYTES[detectAddressType(out.address)],
    0,
  );
  return Math.ceil(TX_OVERHEAD_VBYTES + P2WPKH_INPUT_VBYTES * params.inputCount + outputVbytes);
}
