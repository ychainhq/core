/**
 * Unit tests — TronAdapter.buildUnsignedWithdrawalTx()
 *
 * Covers:
 * - TRX path: calls createUnsignedTrxTransfer, returns { unsignedPayload, txID }
 * - USDT path (TRC-20): calls createUnsignedTrc20Transfer, returns { unsignedPayload, txID }
 * - Error: TRC-20 without contractAddress → ApiError 400 MISSING_CONTRACT_ADDRESS
 * - Verify correct params forwarded to each RPC method
 *
 * No real network I/O — fetch is mocked at the global level.
 */
import { TronAdapter } from '../../src/chain-adapters/tron/adapter';
import { NodeSelector } from '../../src/chain-adapters/node-selector';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_NODE = {
  url: 'http://tron-node.test:8090',
  timeoutMs: 5000,
  maxAttempts: 1,
  retryDelayMs: 0,
};

const UNSIGNED_TX = {
  txID: 'deadbeef0011223344556677deadbeef0011223344556677deadbeef00112233',
  raw_data: { contract: [] },
  raw_data_hex: 'cafe0102030405',
};

// TRC-20 triggersmartcontract response wraps the tx inside `.transaction`
const TRC20_RESPONSE = {
  result: { result: true },
  transaction: UNSIGNED_TX,
};

function makeNodeSelector(): NodeSelector {
  const sel = Object.create(null) as NodeSelector;
  sel.getNodes = jest.fn().mockResolvedValue([MOCK_NODE]);
  return sel;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TronAdapter.buildUnsignedWithdrawalTx() — TRX (native)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('calls createtransaction endpoint and returns { unsignedPayload, txID }', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(UNSIGNED_TX),
    } as unknown as Response);

    const adapter = new TronAdapter(makeNodeSelector());
    const result = await adapter.buildUnsignedWithdrawalTx({
      fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
      toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      assetId: 'tron:TRX',
      amountRaw: '5000000',
      feeLimitSun: 40_000_000,
    });

    expect(result.txID).toBe(UNSIGNED_TX.txID);
    expect(result.unsignedPayload).toBe(UNSIGNED_TX.raw_data_hex);

    // Verify the correct TRON endpoint was hit
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/wallet/createtransaction');
  });

  it('forwards fromAddress, toAddress, amountRaw as amount (number)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(UNSIGNED_TX),
    } as unknown as Response);

    const adapter = new TronAdapter(makeNodeSelector());
    await adapter.buildUnsignedWithdrawalTx({
      fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
      toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      assetId: 'tron:TRX',
      amountRaw: '123456',
      feeLimitSun: 40_000_000,
    });

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.owner_address).toBe('TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN');
    expect(body.to_address).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(body.amount).toBe(123456); // number, not string
  });
});

describe('TronAdapter.buildUnsignedWithdrawalTx() — USDT (TRC-20)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('calls triggersmartcontract endpoint and returns { unsignedPayload, txID }', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(TRC20_RESPONSE),
    } as unknown as Response);

    const adapter = new TronAdapter(makeNodeSelector());
    const result = await adapter.buildUnsignedWithdrawalTx({
      fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
      toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      assetId: 'tron:USDT',
      amountRaw: '10000000',
      feeLimitSun: 40_000_000,
      contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT mainnet contract
    });

    expect(result.txID).toBe(UNSIGNED_TX.txID);
    expect(result.unsignedPayload).toBe(UNSIGNED_TX.raw_data_hex);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/wallet/triggersmartcontract');
  });

  it('forwards feeLimitSun as fee_limit param', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(TRC20_RESPONSE),
    } as unknown as Response);

    const adapter = new TronAdapter(makeNodeSelector());
    await adapter.buildUnsignedWithdrawalTx({
      fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
      toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      assetId: 'tron:USDT',
      amountRaw: '10000000',
      feeLimitSun: 40_000_000,
      contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    });

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.fee_limit).toBe(40_000_000);
    expect(body.contract_address).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(body.function_selector).toBe('transfer(address,uint256)');
  });

  it('throws ApiError 400 MISSING_CONTRACT_ADDRESS when contractAddress is omitted', async () => {
    jest.spyOn(global, 'fetch'); // should not be called
    const adapter = new TronAdapter(makeNodeSelector());

    await expect(
      adapter.buildUnsignedWithdrawalTx({
        fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
        toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        assetId: 'tron:USDT',
        amountRaw: '10000000',
        feeLimitSun: 40_000_000,
        // contractAddress intentionally omitted
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'MISSING_CONTRACT_ADDRESS' });
  });
});
