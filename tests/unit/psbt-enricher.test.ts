import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { enrichSweepPsbt, accountFingerprintFromXpub } from '../../src/chain-adapters/bitcoin/psbt-enricher';

jest.mock('../../src/db/client', () => ({ getDbClient: jest.fn() }));
jest.mock('../../src/shared/logging/index', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { getDbClient } from '../../src/db/client';
const mockGetDbClient = getDbClient as jest.Mock;

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NETWORK = bitcoin.networks.regtest;
const TENANT_ID = 'tenant_unit_test';

// Deterministic account node from a known 32-byte seed — never changes between runs
const ACCOUNT_NODE = bip32.fromSeed(
  Buffer.from('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex'),
  NETWORK,
);
const ACCOUNT_XPUB = ACCOUNT_NODE.neutered().toBase58();

/** Derive the P2WPKH output script for address at external chain m/0/{index}. */
function script(index: number): Buffer {
  const child = ACCOUNT_NODE.derive(0).derive(index);
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network: NETWORK }).output!;
}

/** Return the expected compressed pubkey Buffer for m/0/{index}. */
function pubkey(index: number): Buffer {
  return Buffer.from(ACCOUNT_NODE.derive(0).derive(index).publicKey);
}

/**
 * Build a PSBT with witnessUtxo pre-filled per input, simulating
 * createpsbt + utxoupdatepsbt having already run.
 *
 * Each entry in `inputs` supplies the derivationIndex so the correct
 * P2WPKH script is embedded as witnessUtxo.script — the enricher derives
 * the address from that script, no external address list needed.
 */
function buildPsbt(
  inputs: Array<{ derivationIndex: number; valueSat?: number; omitWitnessUtxo?: boolean }>,
  outputIndex = 99,
): string {
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  const outputAddr = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(ACCOUNT_NODE.derive(0).derive(outputIndex).publicKey),
    network: NETWORK,
  }).address!;

  for (let i = 0; i < inputs.length; i++) {
    const { derivationIndex, valueSat = 100_000, omitWitnessUtxo = false } = inputs[i];
    const inputDef: any = {
      hash: Buffer.alloc(32, i + 1), // unique fake txid per slot
      index: 0,
    };
    if (!omitWitnessUtxo) {
      inputDef.witnessUtxo = { script: script(derivationIndex), value: valueSat };
    }
    psbt.addInput(inputDef);
  }

  const totalIn = inputs.reduce((s, u) => s + (u.valueSat ?? 100_000), 0);
  psbt.addOutput({ address: outputAddr, value: totalIn - 10_000 });
  return psbt.toBase64();
}

/**
 * Wire up the DB mock so that db.get() returns derivation metadata for
 * each derivationIndex. Pass null to simulate an unknown address.
 */
function mockDb(metaByIndex: Record<number, { derivationIndex: number } | null>): void {
  mockGetDbClient.mockReturnValue({
    get: jest.fn(async (_sql: string, [, address]: [string, string]) => {
      // Find which index this address maps to, then return the configured metadata
      for (const [idx, meta] of Object.entries(metaByIndex)) {
        const expectedAddr = bitcoin.payments.p2wpkh({
          pubkey: Buffer.from(ACCOUNT_NODE.derive(0).derive(Number(idx)).publicKey),
          network: NETWORK,
        }).address!;
        if (address === expectedAddr) {
          if (!meta) return undefined;
          return { metadata: JSON.stringify(meta) };
        }
      }
      return undefined;
    }),
  });
}

beforeEach(() => jest.clearAllMocks());

// ─── enrichSweepPsbt ──────────────────────────────────────────────────────────

describe('enrichSweepPsbt', () => {

  // ── Happy path: single input ────────────────────────────────────────────────

  describe('single input', () => {
    it('adds bip32Derivation to the input', async () => {
      mockDb({ 0: { derivationIndex: 0 } });
      const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

      const enriched = bitcoin.Psbt.fromBase64(result, { network: NETWORK });
      expect(enriched.data.inputs[0].bip32Derivation).toHaveLength(1);
    });

    it('embeds the correct compressed pubkey for derivationIndex 0', async () => {
      mockDb({ 0: { derivationIndex: 0 } });
      const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

      const [deriv] = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs[0].bip32Derivation!;
      expect(deriv.pubkey.toString('hex')).toBe(pubkey(0).toString('hex'));
    });

    it('sets path to m/0/{derivationIndex}', async () => {
      mockDb({ 7: { derivationIndex: 7 } });
      const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: 7 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

      const [deriv] = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs[0].bip32Derivation!;
      expect(deriv.path).toBe('m/0/7');
    });

    it('masterFingerprint matches accountFingerprintFromXpub', async () => {
      mockDb({ 0: { derivationIndex: 0 } });
      const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

      const [deriv] = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs[0].bip32Derivation!;
      expect(deriv.masterFingerprint.toString('hex')).toBe(accountFingerprintFromXpub(ACCOUNT_XPUB, NETWORK));
    });

    it('derivationIndex 0 is handled correctly (falsy-safe)', async () => {
      mockDb({ 0: { derivationIndex: 0 } });
      const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

      const [deriv] = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs[0].bip32Derivation!;
      expect(deriv.path).toBe('m/0/0');
    });

    it('works for a high derivation index', async () => {
      const INDEX = 500;
      mockDb({ [INDEX]: { derivationIndex: INDEX } });
      const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: INDEX }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

      const [deriv] = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs[0].bip32Derivation!;
      expect(deriv.path).toBe(`m/0/${INDEX}`);
      expect(deriv.pubkey.toString('hex')).toBe(pubkey(INDEX).toString('hex'));
    });
  });

  // ── Happy path: multiple inputs, different addresses ────────────────────────

  describe('multiple inputs, different addresses', () => {
    it('enriches each input independently with the correct derivation', async () => {
      mockDb({ 0: { derivationIndex: 0 }, 1: { derivationIndex: 1 } });
      const result = await enrichSweepPsbt(
        buildPsbt([{ derivationIndex: 0 }, { derivationIndex: 1 }]),
        TENANT_ID, ACCOUNT_XPUB, NETWORK,
      );

      const inputs = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs;
      expect(inputs[0].bip32Derivation![0].path).toBe('m/0/0');
      expect(inputs[1].bip32Derivation![0].path).toBe('m/0/1');
      expect(inputs[0].bip32Derivation![0].pubkey.toString('hex')).toBe(pubkey(0).toString('hex'));
      expect(inputs[1].bip32Derivation![0].pubkey.toString('hex')).toBe(pubkey(1).toString('hex'));
    });

    it('queries the DB once per input (not deduplicated)', async () => {
      const db = { get: jest.fn().mockResolvedValue({ metadata: JSON.stringify({ derivationIndex: 0 }) }) };
      mockGetDbClient.mockReturnValue(db);

      await enrichSweepPsbt(
        buildPsbt([{ derivationIndex: 0 }, { derivationIndex: 0 }, { derivationIndex: 0 }]),
        TENANT_ID, ACCOUNT_XPUB, NETWORK,
      );

      expect(db.get).toHaveBeenCalledTimes(3);
    });
  });

  // ── Multiple UTXOs from same address (the dedup bug — now fixed) ────────────

  describe('multiple UTXOs from same address', () => {
    it('enriches both inputs correctly when two UTXOs share an address', async () => {
      // Previously: SweepWorker passed deduplicated inputAddresses → enricher threw.
      // Now: enricher derives address per input from witnessUtxo.script → no mismatch.
      mockDb({ 0: { derivationIndex: 0 } });
      const result = await enrichSweepPsbt(
        buildPsbt([{ derivationIndex: 0 }, { derivationIndex: 0 }]),
        TENANT_ID, ACCOUNT_XPUB, NETWORK,
      );

      const inputs = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs;
      expect(inputs[0].bip32Derivation![0].path).toBe('m/0/0');
      expect(inputs[1].bip32Derivation![0].path).toBe('m/0/0');
    });

    it('enriches three inputs from same address correctly', async () => {
      mockDb({ 3: { derivationIndex: 3 } });
      const result = await enrichSweepPsbt(
        buildPsbt([{ derivationIndex: 3 }, { derivationIndex: 3 }, { derivationIndex: 3 }]),
        TENANT_ID, ACCOUNT_XPUB, NETWORK,
      );

      const inputs = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs;
      expect(inputs).toHaveLength(3);
      inputs.forEach(input => expect(input.bip32Derivation![0].path).toBe('m/0/3'));
    });

    it('handles mixed: two UTXOs from addr0, one from addr1', async () => {
      mockDb({ 0: { derivationIndex: 0 }, 1: { derivationIndex: 1 } });
      const result = await enrichSweepPsbt(
        buildPsbt([{ derivationIndex: 0 }, { derivationIndex: 1 }, { derivationIndex: 0 }]),
        TENANT_ID, ACCOUNT_XPUB, NETWORK,
      );

      const inputs = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs;
      expect(inputs[0].bip32Derivation![0].path).toBe('m/0/0');
      expect(inputs[1].bip32Derivation![0].path).toBe('m/0/1');
      expect(inputs[2].bip32Derivation![0].path).toBe('m/0/0');
    });
  });

  // ── witnessUtxo missing ─────────────────────────────────────────────────────

  describe('missing witnessUtxo', () => {
    it('throws when an input has no witnessUtxo (utxoupdatepsbt not run)', async () => {
      await expect(
        enrichSweepPsbt(
          buildPsbt([{ derivationIndex: 0, omitWitnessUtxo: true }]),
          TENANT_ID, ACCOUNT_XPUB, NETWORK,
        ),
      ).rejects.toThrow('witnessUtxo.script is missing');
    });

    it('throws on the correct input index when only the second input lacks witnessUtxo', async () => {
      mockDb({ 0: { derivationIndex: 0 } });
      await expect(
        enrichSweepPsbt(
          buildPsbt([{ derivationIndex: 0 }, { derivationIndex: 1, omitWitnessUtxo: true }]),
          TENANT_ID, ACCOUNT_XPUB, NETWORK,
        ),
      ).rejects.toThrow('Cannot enrich PSBT input 1');
    });
  });

  // ── DB / metadata error cases ───────────────────────────────────────────────

  describe('DB and metadata errors', () => {
    it('throws when address is not in the DB', async () => {
      mockDb({ 0: null });
      await expect(
        enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK),
      ).rejects.toThrow('has no derivation metadata in DB');
    });

    it('throws when DB returns a row with metadata: null', async () => {
      mockGetDbClient.mockReturnValue({ get: jest.fn().mockResolvedValue({ metadata: null }) });
      await expect(
        enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK),
      ).rejects.toThrow('has no derivation metadata in DB');
    });

    it('throws when metadata is not valid JSON', async () => {
      mockGetDbClient.mockReturnValue({ get: jest.fn().mockResolvedValue({ metadata: '{not: valid json' }) });
      await expect(
        enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK),
      ).rejects.toThrow('is not valid JSON');
    });

    it('throws when derivationIndex is absent from metadata', async () => {
      mockGetDbClient.mockReturnValue({
        get: jest.fn().mockResolvedValue({ metadata: JSON.stringify({ derivationPath: 'm/0/0' }) }),
      });
      await expect(
        enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK),
      ).rejects.toThrow('derivationIndex missing');
    });

    it('throws when derivationIndex is null', async () => {
      mockGetDbClient.mockReturnValue({
        get: jest.fn().mockResolvedValue({ metadata: JSON.stringify({ derivationIndex: null }) }),
      });
      await expect(
        enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK),
      ).rejects.toThrow('derivationIndex missing');
    });

    it('fails on the correct input index when only the second address is missing', async () => {
      mockGetDbClient.mockReturnValue({
        get: jest.fn()
          .mockResolvedValueOnce({ metadata: JSON.stringify({ derivationIndex: 0 }) })
          .mockResolvedValueOnce(undefined),
      });
      await expect(
        enrichSweepPsbt(
          buildPsbt([{ derivationIndex: 0 }, { derivationIndex: 1 }]),
          TENANT_ID, ACCOUNT_XPUB, NETWORK,
        ),
      ).rejects.toThrow('Cannot enrich PSBT input 1');
    });
  });

  // ── Invalid arguments ───────────────────────────────────────────────────────

  describe('invalid arguments', () => {
    it('throws on a non-PSBT base64 string', async () => {
      await expect(
        enrichSweepPsbt('definitely-not-a-psbt!!', TENANT_ID, ACCOUNT_XPUB, NETWORK),
      ).rejects.toThrow();
    });

    it('throws on an invalid xpub string', async () => {
      mockDb({ 0: { derivationIndex: 0 } });
      await expect(
        enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, 'xpubTHIS_IS_GARBAGE', NETWORK),
      ).rejects.toThrow();
    });
  });

  // ── Output PSBT correctness ─────────────────────────────────────────────────

  describe('output PSBT correctness', () => {
    it('returns a parseable base64-encoded PSBT', async () => {
      mockDb({ 0: { derivationIndex: 0 } });
      const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

      expect(() => bitcoin.Psbt.fromBase64(result, { network: NETWORK })).not.toThrow();
    });

    it('does not alter outputs', async () => {
      mockDb({ 0: { derivationIndex: 0 } });
      const psbtB64 = buildPsbt([{ derivationIndex: 0 }]);
      const result = await enrichSweepPsbt(psbtB64, TENANT_ID, ACCOUNT_XPUB, NETWORK);

      const before = bitcoin.Psbt.fromBase64(psbtB64, { network: NETWORK }).txOutputs;
      const after = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).txOutputs;
      expect(after).toEqual(before);
    });

    it('enriched PSBT input count matches original', async () => {
      mockDb({ 0: { derivationIndex: 0 }, 1: { derivationIndex: 1 } });
      const result = await enrichSweepPsbt(
        buildPsbt([{ derivationIndex: 0 }, { derivationIndex: 1 }]),
        TENANT_ID, ACCOUNT_XPUB, NETWORK,
      );

      expect(bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs).toHaveLength(2);
    });

    it('each input has exactly one bip32Derivation entry', async () => {
      mockDb({ 0: { derivationIndex: 0 }, 2: { derivationIndex: 2 } });
      const result = await enrichSweepPsbt(
        buildPsbt([{ derivationIndex: 0 }, { derivationIndex: 2 }]),
        TENANT_ID, ACCOUNT_XPUB, NETWORK,
      );

      bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs
        .forEach(input => expect(input.bip32Derivation).toHaveLength(1));
    });
  });

  // ── Derivation precision ────────────────────────────────────────────────────

  describe('derivation precision', () => {
    it('pubkey at index 0 matches derive(0).derive(0).publicKey', async () => {
      mockDb({ 0: { derivationIndex: 0 } });
      const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

      const [deriv] = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs[0].bip32Derivation!;
      expect(deriv.pubkey.toString('hex')).toBe(pubkey(0).toString('hex'));
    });

    it('pubkey at high index matches derived child', async () => {
      const INDEX = 100;
      mockDb({ [INDEX]: { derivationIndex: INDEX } });
      const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: INDEX }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

      const [deriv] = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs[0].bip32Derivation!;
      expect(deriv.pubkey.toString('hex')).toBe(pubkey(INDEX).toString('hex'));
      expect(deriv.path).toBe(`m/0/${INDEX}`);
    });
  });
});

// ─── accountFingerprintFromXpub ───────────────────────────────────────────────

describe('accountFingerprintFromXpub', () => {
  it('returns an 8-character lowercase hex string (4 bytes)', () => {
    expect(accountFingerprintFromXpub(ACCOUNT_XPUB, NETWORK)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('matches the raw bip32 node fingerprint', () => {
    const node = bip32.fromBase58(ACCOUNT_XPUB, NETWORK);
    expect(accountFingerprintFromXpub(ACCOUNT_XPUB, NETWORK))
      .toBe(Buffer.from(node.fingerprint).toString('hex'));
  });

  it('matches the masterFingerprint embedded by enrichSweepPsbt', async () => {
    mockDb({ 0: { derivationIndex: 0 } });
    const result = await enrichSweepPsbt(buildPsbt([{ derivationIndex: 0 }]), TENANT_ID, ACCOUNT_XPUB, NETWORK);

    const [deriv] = bitcoin.Psbt.fromBase64(result, { network: NETWORK }).data.inputs[0].bip32Derivation!;
    expect(deriv.masterFingerprint.toString('hex')).toBe(accountFingerprintFromXpub(ACCOUNT_XPUB, NETWORK));
  });

  it('different xpubs produce different fingerprints', () => {
    const otherNode = bip32.fromSeed(
      Buffer.from('cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe', 'hex'),
      NETWORK,
    );
    expect(accountFingerprintFromXpub(ACCOUNT_XPUB, NETWORK))
      .not.toBe(accountFingerprintFromXpub(otherNode.neutered().toBase58(), NETWORK));
  });

  it('throws on an invalid xpub string', () => {
    expect(() => accountFingerprintFromXpub('xpub_garbage', NETWORK)).toThrow();
  });

  it('is deterministic across multiple calls', () => {
    expect(accountFingerprintFromXpub(ACCOUNT_XPUB, NETWORK))
      .toBe(accountFingerprintFromXpub(ACCOUNT_XPUB, NETWORK));
  });
});
