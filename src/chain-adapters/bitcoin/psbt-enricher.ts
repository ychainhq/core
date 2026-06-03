/**
 * PSBT Enricher — adds bip32Derivation hints to sweep PSBT inputs.
 *
 * After createUnsignedPsbt() builds the raw unsigned PSBT (createpsbt + utxoupdatepsbt),
 * this module enriches each input with the BIP-32 derivation path and compressed public
 * key so that an external signer daemon can derive the correct child private key per input.
 *
 * The source address for each input is derived directly from input.witnessUtxo.script
 * (embedded by utxoupdatepsbt), so the caller does not need to supply an address list.
 * This eliminates the deduplication bug that occurred when multiple UTXOs shared an address.
 *
 * Uses only public-key operations — no private key material is ever present in engine.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { getDbClient } from '../../db/client';
import { logger } from '../../shared/logging/index';

try { bitcoin.initEccLib(ecc); } catch { /* already initialized */ }
const bip32 = BIP32Factory(ecc);

export async function enrichSweepPsbt(
  psbtBase64: string,
  tenantId: string,
  accountXpub: string,        // account-level xpub from tenant_configs.btc_xpub
  network: bitcoin.networks.Network
): Promise<string> {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });

  const accountNode = bip32.fromBase58(accountXpub, network);
  // fingerprint = first 4 bytes of hash160(accountNode.publicKey) — identifies this key to the signer
  const masterFingerprint = Buffer.from(accountNode.fingerprint);

  const db = getDbClient();

  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const input = psbt.data.inputs[i];

    if (!input.witnessUtxo?.script) {
      throw new Error(
        `Cannot enrich PSBT input ${i}: witnessUtxo.script is missing — run utxoupdatepsbt first`
      );
    }

    const address = bitcoin.address.fromOutputScript(input.witnessUtxo.script, network);

    const row = await db.get<{ metadata: string | null }>(
      'SELECT metadata FROM addresses WHERE tenant_id = ? AND address = ? LIMIT 1',
      [tenantId, address]
    );

    if (!row?.metadata) {
      throw new Error(
        `Cannot enrich PSBT input ${i}: address ${address} has no derivation metadata in DB`
      );
    }

    let meta: { derivationIndex?: number; derivationPath?: string };
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      throw new Error(`Cannot enrich PSBT input ${i}: metadata for ${address} is not valid JSON`);
    }

    const index = meta.derivationIndex;
    if (index === undefined || index === null) {
      throw new Error(`Cannot enrich PSBT input ${i}: derivationIndex missing for ${address}`);
    }

    // Derive child public key at m/0/{index} from account xpub (public-key only)
    const childNode = accountNode.derive(0).derive(index);
    const pubkey = Buffer.from(childNode.publicKey);
    const path = `m/0/${index}`; // relative to account xpub, signer uses accountNode.derivePath(path)

    psbt.updateInput(i, {
      bip32Derivation: [{ masterFingerprint, pubkey, path }],
    });

    logger.debug('enrichSweepPsbt: input enriched', { i, address, path, tenantId });
  }

  return psbt.toBase64();
}

/**
 * Compute the account fingerprint from xpub — used by signers to match bip32Derivation entries.
 * Returns the same 4-byte hex string that enrichSweepPsbt embeds as masterFingerprint.
 */
export function accountFingerprintFromXpub(
  accountXpub: string,
  network: bitcoin.networks.Network
): string {
  const node = bip32.fromBase58(accountXpub, network);
  return Buffer.from(node.fingerprint).toString('hex');
}
