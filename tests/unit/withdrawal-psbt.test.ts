/**
 * Unit tests for:
 *   BitcoinAdapter.buildWithdrawalPsbt — fee calculation, change, dust, RBF
 *   BitcoinAdapter.estimateFeeRateSatVb — caching, fallback, min/max clamping
 */

import { BitcoinAdapter } from '../../src/chain-adapters/bitcoin/adapter';
import { BitcoinRpcClient } from '../../src/chain-adapters/bitcoin/rpc-client';

jest.mock('../../src/chain-adapters/bitcoin/rpc-client');

const MockedRpcClient = BitcoinRpcClient as jest.MockedClass<typeof BitcoinRpcClient>;

const WPKH  = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // P2WPKH — 31 vbytes output
const WPKH2 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'; // change address P2WPKH
const PTR   = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'; // P2TR — 43 vbytes
const TXID  = 'a'.repeat(64);
const TXID2 = 'b'.repeat(64);

describe('BitcoinAdapter.buildWithdrawalPsbt', () => {
  let adapter: BitcoinAdapter;
  let mockCreatePsbt: jest.Mock;
  let mockUtxoUpdatePsbt: jest.Mock;

  beforeEach(() => {
    mockCreatePsbt = jest.fn().mockResolvedValue('mock-unsigned-psbt');
    mockUtxoUpdatePsbt = jest.fn().mockResolvedValue('mock-updated-psbt');

    MockedRpcClient.mockImplementation(() => ({
      createPsbt: mockCreatePsbt,
      utxoUpdatePsbt: mockUtxoUpdatePsbt,
    } as any));

    adapter = new BitcoinAdapter();
  });

  afterEach(() => jest.clearAllMocks());

  // ─── happy path ─────────────────────────────────────────────────────────────

  test('returns PSBT from utxoUpdatePsbt and correct feeSats', async () => {
    // vsize with change = ceil(10.5 + 68 + 31 + 31) = ceil(140.5) = 141
    // fee = ceil(141 * 10) = 1410
    // change = 100_000 - 50_000 - 1_410 = 48_590 (> 546 dust)
    const result = await adapter.buildWithdrawalPsbt({
      inputs: [{ txid: TXID, vout: 0, amountSats: 100_000n }],
      recipientOutputs: [{ address: WPKH, amountSats: 50_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 10,
      rbf: false,
    });

    expect(result.psbt).toBe('mock-updated-psbt');
    expect(result.feeSats).toBe(1_410n);
  });

  test('outputs passed to createPsbt include recipient + change', async () => {
    // change = 100_000 - 50_000 - 1_410 = 48_590
    await adapter.buildWithdrawalPsbt({
      inputs: [{ txid: TXID, vout: 0, amountSats: 100_000n }],
      recipientOutputs: [{ address: WPKH, amountSats: 50_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 10,
      rbf: false,
    });

    const [psbtInputs, psbtOutputs] = mockCreatePsbt.mock.calls[0] as [any[], any[]];
    expect(psbtOutputs).toHaveLength(2);
    expect(Object.keys(psbtOutputs[0]!)[0]).toBe(WPKH);   // recipient
    expect(Object.keys(psbtOutputs[1]!)[0]).toBe(WPKH2);  // change
    expect(psbtInputs).toHaveLength(1);
  });

  test('calls createPsbt and utxoUpdatePsbt exactly once each', async () => {
    await adapter.buildWithdrawalPsbt({
      inputs: [{ txid: TXID, vout: 0, amountSats: 100_000n }],
      recipientOutputs: [{ address: WPKH, amountSats: 50_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 10,
      rbf: false,
    });

    expect(mockCreatePsbt).toHaveBeenCalledTimes(1);
    expect(mockUtxoUpdatePsbt).toHaveBeenCalledWith('mock-unsigned-psbt');
  });

  // ─── dust change ────────────────────────────────────────────────────────────

  test('dust change: omits change output, all remainder becomes miner fee', async () => {
    // vsize with change = 141, fee = 1_410
    // change = 51_900 - 50_000 - 1_410 = 490 < 546 → dust → omit
    // actualFee = 51_900 - 50_000 = 1_900
    const result = await adapter.buildWithdrawalPsbt({
      inputs: [{ txid: TXID, vout: 0, amountSats: 51_900n }],
      recipientOutputs: [{ address: WPKH, amountSats: 50_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 10,
      rbf: false,
    });

    expect(result.feeSats).toBe(1_900n);
    const [, psbtOutputs] = mockCreatePsbt.mock.calls[0] as [any[], any[]];
    expect(psbtOutputs).toHaveLength(1);  // no change output
    expect(Object.keys(psbtOutputs[0]!)[0]).toBe(WPKH);
  });

  test('change exactly at dust threshold (546): included', async () => {
    // need: find totalInput where change = 546 exactly
    // vsize = 141, fee = 1_410 (feeRate=10)
    // change = totalInput - 50_000 - 1_410 = 546 → totalInput = 51_956
    const result = await adapter.buildWithdrawalPsbt({
      inputs: [{ txid: TXID, vout: 0, amountSats: 51_956n }],
      recipientOutputs: [{ address: WPKH, amountSats: 50_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 10,
      rbf: false,
    });

    expect(result.feeSats).toBe(1_410n);
    const [, psbtOutputs] = mockCreatePsbt.mock.calls[0] as [any[], any[]];
    expect(psbtOutputs).toHaveLength(2);  // change included
  });

  test('change one below dust threshold (545): omitted', async () => {
    // totalInput = 51_955 → change = 51_955 - 50_000 - 1_410 = 545 < 546
    const result = await adapter.buildWithdrawalPsbt({
      inputs: [{ txid: TXID, vout: 0, amountSats: 51_955n }],
      recipientOutputs: [{ address: WPKH, amountSats: 50_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 10,
      rbf: false,
    });

    expect(result.feeSats).toBe(51_955n - 50_000n);  // 1_955
    const [, psbtOutputs] = mockCreatePsbt.mock.calls[0] as [any[], any[]];
    expect(psbtOutputs).toHaveLength(1);
  });

  // ─── RBF sequences ──────────────────────────────────────────────────────────

  test('rbf: true → all inputs get sequence 0xFFFFFFFD', async () => {
    await adapter.buildWithdrawalPsbt({
      inputs: [
        { txid: TXID,  vout: 0, amountSats: 100_000n },
        { txid: TXID2, vout: 1, amountSats: 100_000n },
      ],
      recipientOutputs: [{ address: WPKH, amountSats: 150_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 5,
      rbf: true,
    });

    const [psbtInputs] = mockCreatePsbt.mock.calls[0] as [any[]];
    expect(psbtInputs).toHaveLength(2);
    expect(psbtInputs[0]!.sequence).toBe(0xFFFFFFFD);
    expect(psbtInputs[1]!.sequence).toBe(0xFFFFFFFD);
  });

  test('rbf: false → inputs have no sequence field', async () => {
    await adapter.buildWithdrawalPsbt({
      inputs: [{ txid: TXID, vout: 0, amountSats: 100_000n }],
      recipientOutputs: [{ address: WPKH, amountSats: 50_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 10,
      rbf: false,
    });

    const [psbtInputs] = mockCreatePsbt.mock.calls[0] as [any[]];
    expect(psbtInputs[0]!.sequence).toBeUndefined();
  });

  // ─── output address types affect fee ────────────────────────────────────────

  test('P2TR recipient: uses 43-vbyte output size → larger fee', async () => {
    // vsize with change = ceil(10.5 + 68 + 43 + 31) = ceil(152.5) = 153
    // fee = ceil(153 * 10) = 1_530
    const result = await adapter.buildWithdrawalPsbt({
      inputs: [{ txid: TXID, vout: 0, amountSats: 200_000n }],
      recipientOutputs: [{ address: PTR, amountSats: 100_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 10,
      rbf: false,
    });

    expect(result.feeSats).toBe(1_530n);
  });

  test('multiple recipients: vsize scales with output count', async () => {
    // 1 input, 3 P2WPKH recipients + 1 P2WPKH change = 4 outputs
    // vsize = ceil(10.5 + 68 + 31*4) = ceil(202.5) = 203
    // fee = ceil(203 * 10) = 2_030
    const result = await adapter.buildWithdrawalPsbt({
      inputs: [{ txid: TXID, vout: 0, amountSats: 500_000n }],
      recipientOutputs: [
        { address: WPKH,  amountSats: 100_000n },
        { address: WPKH2, amountSats: 100_000n },
        { address: WPKH,  amountSats: 100_000n },
      ],
      changeAddress: WPKH2,
      feeRateSatVb: 10,
      rbf: false,
    });

    expect(result.feeSats).toBe(2_030n);
  });

  // ─── insufficient funds ──────────────────────────────────────────────────────

  test('throws ValidationError when UTXOs cannot cover outputs + fee', async () => {
    // Input: 1_000 sats. Output: 999 sats. Fee would be ~1_410 → 1_000 - 999 - 1_410 < 0
    await expect(
      adapter.buildWithdrawalPsbt({
        inputs: [{ txid: TXID, vout: 0, amountSats: 1_000n }],
        recipientOutputs: [{ address: WPKH, amountSats: 999n }],
        changeAddress: WPKH2,
        feeRateSatVb: 10,
        rbf: false,
      }),
    ).rejects.toThrow('Insufficient UTXOs');
  });

  test('throws when output amount exactly equals input (no room for fee)', async () => {
    await expect(
      adapter.buildWithdrawalPsbt({
        inputs: [{ txid: TXID, vout: 0, amountSats: 50_000n }],
        recipientOutputs: [{ address: WPKH, amountSats: 50_000n }],
        changeAddress: WPKH2,
        feeRateSatVb: 1,
        rbf: false,
      }),
    ).rejects.toThrow('Insufficient UTXOs');
  });

  // ─── multi-input ─────────────────────────────────────────────────────────────

  test('multiple inputs: fee scales correctly with input count', async () => {
    // 3 inputs, 1 P2WPKH output + 1 P2WPKH change
    // vsize = ceil(10.5 + 68*3 + 31*2) = ceil(10.5 + 204 + 62) = ceil(276.5) = 277
    // fee = ceil(277 * 5) = 1_385
    const result = await adapter.buildWithdrawalPsbt({
      inputs: [
        { txid: TXID,  vout: 0, amountSats: 50_000n },
        { txid: TXID2, vout: 1, amountSats: 50_000n },
        { txid: TXID2, vout: 2, amountSats: 50_000n },
      ],
      recipientOutputs: [{ address: WPKH, amountSats: 100_000n }],
      changeAddress: WPKH2,
      feeRateSatVb: 5,
      rbf: false,
    });

    expect(result.feeSats).toBe(1_385n);
  });
});

// ─── estimateFeeRateSatVb ────────────────────────────────────────────────────

describe('BitcoinAdapter.estimateFeeRateSatVb', () => {
  let adapter: BitcoinAdapter;
  let spyEstimateSmartFee: jest.SpyInstance;

  beforeEach(() => {
    MockedRpcClient.mockImplementation(() => ({
      estimateSmartFee: jest.fn(),
      createPsbt: jest.fn(),
      utxoUpdatePsbt: jest.fn(),
    } as any));

    adapter = new BitcoinAdapter(); // fresh instance = empty cache per test

    // Mock at adapter level to skip the BTC/kB → sat/vbyte conversion in estimateSmartFee
    spyEstimateSmartFee = jest
      .spyOn(adapter, 'estimateSmartFee')
      .mockResolvedValue({ feeRate: 20, targetBlocks: 6, mode: 'conservative' });
  });

  afterEach(() => jest.restoreAllMocks());

  test('returns feeRate from estimateSmartFee on first call', async () => {
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6 });
    expect(rate).toBe(20);
    expect(spyEstimateSmartFee).toHaveBeenCalledTimes(1);
  });

  test('second call with same params returns cached value — RPC not called again', async () => {
    await adapter.estimateFeeRateSatVb({ targetBlocks: 6 });
    await adapter.estimateFeeRateSatVb({ targetBlocks: 6 });
    expect(spyEstimateSmartFee).toHaveBeenCalledTimes(1);
  });

  test('different targetBlocks = different cache key — both call RPC', async () => {
    await adapter.estimateFeeRateSatVb({ targetBlocks: 6 });
    await adapter.estimateFeeRateSatVb({ targetBlocks: 2 });
    expect(spyEstimateSmartFee).toHaveBeenCalledTimes(2);
  });

  test('different maxSatVb = different cache key — both call RPC', async () => {
    await adapter.estimateFeeRateSatVb({ targetBlocks: 6, maxSatVb: 50 });
    await adapter.estimateFeeRateSatVb({ targetBlocks: 6, maxSatVb: 30 });
    expect(spyEstimateSmartFee).toHaveBeenCalledTimes(2);
  });

  test('RPC throws → returns fallbackSatVb (default 5)', async () => {
    spyEstimateSmartFee.mockRejectedValue(new Error('estimatesmartfee unavailable'));
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6 });
    expect(rate).toBe(5);
  });

  test('RPC throws → returns custom fallbackSatVb when provided', async () => {
    spyEstimateSmartFee.mockRejectedValue(new Error('rpc down'));
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6, fallbackSatVb: 3 });
    expect(rate).toBe(3);
  });

  test('maxSatVb clamp: RPC returns 100, maxSatVb=50 → returns 50', async () => {
    spyEstimateSmartFee.mockResolvedValue({ feeRate: 100, targetBlocks: 6, mode: 'conservative' });
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6, maxSatVb: 50 });
    expect(rate).toBe(50);
  });

  test('maxSatVb clamp: RPC returns 20, maxSatVb=50 → returns 20 (below ceiling)', async () => {
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6, maxSatVb: 50 });
    expect(rate).toBe(20);
  });

  test('minSatVb clamp: RPC returns 2, minSatVb=10 → returns 10', async () => {
    spyEstimateSmartFee.mockResolvedValue({ feeRate: 2, targetBlocks: 6, mode: 'conservative' });
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6, minSatVb: 10 });
    expect(rate).toBe(10);
  });

  test('minSatVb clamp: RPC returns 20, minSatVb=10 → returns 20 (above floor)', async () => {
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6, minSatVb: 10 });
    expect(rate).toBe(20);
  });

  test('minSatVb=null → no floor clamp applied', async () => {
    spyEstimateSmartFee.mockResolvedValue({ feeRate: 1, targetBlocks: 6, mode: 'conservative' });
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6, minSatVb: null });
    expect(rate).toBe(1);
  });

  test('both maxSatVb and minSatVb: RPC returns 3, min=5, max=50 → returns 5', async () => {
    spyEstimateSmartFee.mockResolvedValue({ feeRate: 3, targetBlocks: 6, mode: 'conservative' });
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6, maxSatVb: 50, minSatVb: 5 });
    expect(rate).toBe(5);
  });

  test('both maxSatVb and minSatVb: RPC returns 80, min=5, max=50 → returns 50', async () => {
    spyEstimateSmartFee.mockResolvedValue({ feeRate: 80, targetBlocks: 6, mode: 'conservative' });
    const rate = await adapter.estimateFeeRateSatVb({ targetBlocks: 6, maxSatVb: 50, minSatVb: 5 });
    expect(rate).toBe(50);
  });
});
