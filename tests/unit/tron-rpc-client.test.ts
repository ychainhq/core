/**
 * Unit tests — TronRpcClient.createUnsignedTrxTransfer()
 *
 * Covers:
 * - Happy path: correct POST to /wallet/createtransaction, correct params, returns TronUnsignedTransaction
 * - Error: TRON API returns Error field → throws
 * - Error: TRON API returns response without txID → throws
 * - Error: no TRON nodes configured → throws ApiError 503
 * - Failover: first node fails, second node succeeds
 *
 * All fetch calls are mocked — no real network I/O.
 */
import { TronRpcClient } from '../../src/chain-adapters/tron/rpc-client';
import { NodeSelector } from '../../src/chain-adapters/node-selector';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_NODE = {
  url: 'http://tron-node.test:8090',
  timeoutMs: 5000,
  maxAttempts: 1,
  retryDelayMs: 0,
};

const MOCK_TX: Record<string, unknown> = {
  txID: 'aabbccdd1122334455667788aabbccdd1122334455667788aabbccdd11223344',
  raw_data: { contract: [] },
  raw_data_hex: 'deadbeef1234',
};

function makeNodeSelector(nodes = [MOCK_NODE]): NodeSelector {
  const selector = Object.create(null) as NodeSelector;
  selector.getNodes = jest.fn().mockResolvedValue(nodes);
  return selector;
}

function mockFetchOk(body: unknown) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

// ── createUnsignedTrxTransfer ─────────────────────────────────────────────────

describe('TronRpcClient.createUnsignedTrxTransfer()', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs to /wallet/createtransaction with correct body', async () => {
    const fetchSpy = mockFetchOk(MOCK_TX);
    const rpc = new TronRpcClient(makeNodeSelector());

    await rpc.createUnsignedTrxTransfer({
      fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
      toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      amountSun: '1000000',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://tron-node.test:8090/wallet/createtransaction');
    expect(opts.method).toBe('POST');

    const sentBody = JSON.parse(opts.body as string);
    expect(sentBody.owner_address).toBe('TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN');
    expect(sentBody.to_address).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(sentBody.amount).toBe(1000000); // number, not string
    expect(sentBody.visible).toBe(true);
  });

  it('returns a TronUnsignedTransaction on success', async () => {
    mockFetchOk(MOCK_TX);
    const rpc = new TronRpcClient(makeNodeSelector());

    const result = await rpc.createUnsignedTrxTransfer({
      fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
      toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      amountSun: '5000000',
    });

    expect(result.txID).toBe(MOCK_TX.txID);
    expect(result.raw_data_hex).toBe(MOCK_TX.raw_data_hex);
  });

  it('throws when the API response contains an Error field', async () => {
    mockFetchOk({ Error: 'account not found', txID: undefined });
    const rpc = new TronRpcClient(makeNodeSelector());

    await expect(
      rpc.createUnsignedTrxTransfer({
        fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
        toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        amountSun: '1000',
      })
    ).rejects.toThrow('account not found');
  });

  it('throws when txID is missing from the response', async () => {
    mockFetchOk({ raw_data_hex: 'deadbeef' }); // no txID
    const rpc = new TronRpcClient(makeNodeSelector());

    await expect(
      rpc.createUnsignedTrxTransfer({
        fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
        toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        amountSun: '100',
      })
    ).rejects.toThrow('missing txID');
  });

  it('throws ApiError 503 when no TRON nodes are configured', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const rpc = new TronRpcClient(makeNodeSelector([])); // empty node list

    await expect(
      rpc.createUnsignedTrxTransfer({
        fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
        toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        amountSun: '1000',
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'TRON_NO_NODES' });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('failovers to the second node when the first node is unreachable', async () => {
    const nodes = [
      { url: 'http://dead-node.test:8090', timeoutMs: 100, maxAttempts: 1, retryDelayMs: 0 },
      { url: 'http://live-node.test:8090', timeoutMs: 5000, maxAttempts: 1, retryDelayMs: 0 },
    ];
    jest.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_TX),
      } as unknown as Response);

    const rpc = new TronRpcClient(makeNodeSelector(nodes));
    const result = await rpc.createUnsignedTrxTransfer({
      fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
      toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      amountSun: '1000',
    });

    expect(result.txID).toBe(MOCK_TX.txID);
  });

  it('converts amountSun string to number in the request body', async () => {
    const fetchSpy = mockFetchOk(MOCK_TX);
    const rpc = new TronRpcClient(makeNodeSelector());

    await rpc.createUnsignedTrxTransfer({
      fromAddress: 'TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN',
      toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      amountSun: '9999999999',
    });

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(typeof body.amount).toBe('number');
    expect(body.amount).toBe(9999999999);
  });
});
