/**
 * Unit tests — BitcoinRpcClient N-node failover
 *
 * Verifies that BitcoinRpcClient:
 *  - tries nodes in order returned by NodeSelector
 *  - fails over to the next node on connection-level errors
 *    (BITCOIN_RPC_UNAVAILABLE, BITCOIN_NODE_HTTP_ERROR, BITCOIN_RPC_PARSE_ERROR)
 *  - does NOT fail over on Bitcoin Core RPC application errors
 *    (TX_NOT_FOUND, TX_REJECTED, BITCOIN_RPC_ERROR, etc.)
 *  - throws BITCOIN_RPC_UNAVAILABLE when no nodes are configured
 *  - retries per-node up to node.maxAttempts before failing over
 */

import { BitcoinRpcClient } from '../../src/chain-adapters/bitcoin/rpc-client';
import { NodeSelector, SelectedNode } from '../../src/chain-adapters/node-selector';
import { ApiError } from '../../src/shared/errors/index';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(url: string, overrides: Partial<SelectedNode> = {}): SelectedNode {
  return {
    url,
    user: 'btcuser',
    password: 'btcpass',
    timeoutMs: 1_000,
    maxAttempts: 1,   // single attempt per node by default
    retryDelayMs: 0,
    ...overrides,
  };
}

function makeSelector(nodes: SelectedNode[]): NodeSelector {
  return { chainId: 'bitcoin', getNodes: jest.fn().mockResolvedValue(nodes) } as unknown as NodeSelector;
}

function makeJsonRpcOk<T>(result: T): string {
  return JSON.stringify({ result, error: null, id: 'rpc_1' });
}

function makeJsonRpcError(code: number, message: string): string {
  return JSON.stringify({ result: null, error: { code, message }, id: 'rpc_1' });
}

function mockFetch(responses: Array<() => Response | Promise<Response>>): void {
  let call = 0;
  (global.fetch as jest.Mock) = jest.fn(async () => {
    const factory = responses[call++];
    if (!factory) throw new Error('No more fetch responses');
    return factory();
  });
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function httpErrorResponse(status: number): Response {
  return new Response('', { status });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// ── Tests: no nodes configured ────────────────────────────────────────────────

describe('BitcoinRpcClient — no nodes', () => {
  it('throws BITCOIN_RPC_UNAVAILABLE when NodeSelector returns empty array', async () => {
    const client = new BitcoinRpcClient(makeSelector([]));
    await expect(client.call('getblockcount')).rejects.toMatchObject({
      code: 'BITCOIN_RPC_UNAVAILABLE',
    });
  });
});

// ── Tests: failover on connection errors ──────────────────────────────────────

describe('BitcoinRpcClient — N-node failover', () => {
  it('succeeds on second node when first node is unreachable', async () => {
    const node1 = makeNode('http://node1:8332');
    const node2 = makeNode('http://node2:8332');
    const client = new BitcoinRpcClient(makeSelector([node1, node2]));

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse(makeJsonRpcOk(840_000)));

    const result = await client.call<number>('getblockcount');
    expect(result).toBe(840_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('fails over on BITCOIN_NODE_HTTP_ERROR (HTTP non-200)', async () => {
    const node1 = makeNode('http://node1:8332');
    const node2 = makeNode('http://node2:8332');
    const client = new BitcoinRpcClient(makeSelector([node1, node2]));

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockResolvedValueOnce(httpErrorResponse(503))
      .mockResolvedValueOnce(okResponse(makeJsonRpcOk('blockhash')));

    const result = await client.call<string>('getblockhash', [100]);
    expect(result).toBe('blockhash');
  });

  it('fails over when JSON parse fails on first node', async () => {
    const node1 = makeNode('http://node1:8332');
    const node2 = makeNode('http://node2:8332');
    const client = new BitcoinRpcClient(makeSelector([node1, node2]));

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }))
      .mockResolvedValueOnce(okResponse(makeJsonRpcOk(42)));

    const result = await client.call<number>('getblockcount');
    expect(result).toBe(42);
  });

  it('throws after all nodes fail', async () => {
    const nodes = [makeNode('http://node1:8332'), makeNode('http://node2:8332'), makeNode('http://node3:8332')];
    const client = new BitcoinRpcClient(makeSelector(nodes));

    (global.fetch as jest.Mock) = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.call('getblockcount')).rejects.toMatchObject({ code: 'BITCOIN_RPC_UNAVAILABLE' });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('tries nodes in the order returned by NodeSelector', async () => {
    const node1 = makeNode('http://priority10:8332');
    const node2 = makeNode('http://priority20:8332');
    const client = new BitcoinRpcClient(makeSelector([node1, node2]));

    const calledUrls: string[] = [];
    (global.fetch as jest.Mock) = jest.fn().mockImplementation((url: string) => {
      calledUrls.push(url);
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    await expect(client.call('getblockcount')).rejects.toThrow();
    expect(calledUrls[0]).toContain('priority10');
    expect(calledUrls[1]).toContain('priority20');
  });
});

// ── Tests: no failover on RPC application errors ──────────────────────────────

describe('BitcoinRpcClient — no failover on RPC errors', () => {
  it('does NOT fail over on TX_NOT_FOUND (RPC code -5)', async () => {
    const nodes = [makeNode('http://node1:8332'), makeNode('http://node2:8332')];
    const client = new BitcoinRpcClient(makeSelector(nodes));

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockResolvedValue(okResponse(makeJsonRpcError(-5, 'No such mempool or blockchain transaction')));

    await expect(client.call('getrawtransaction', ['badhash'])).rejects.toMatchObject({
      code: 'TX_NOT_FOUND',
    });
    // Only called once — no failover
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT fail over on TX_REJECTED (RPC code -25)', async () => {
    const nodes = [makeNode('http://node1:8332'), makeNode('http://node2:8332')];
    const client = new BitcoinRpcClient(makeSelector(nodes));

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockResolvedValue(okResponse(makeJsonRpcError(-25, 'Missing inputs')));

    await expect(client.call('sendrawtransaction', ['deadbeef'])).rejects.toMatchObject({
      code: 'TX_REJECTED',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT fail over on generic BITCOIN_RPC_ERROR (RPC code -32601)', async () => {
    const nodes = [makeNode('http://node1:8332'), makeNode('http://node2:8332')];
    const client = new BitcoinRpcClient(makeSelector(nodes));

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockResolvedValue(okResponse(makeJsonRpcError(-32601, 'Method not found')));

    await expect(client.call('unknownmethod')).rejects.toMatchObject({ code: 'BITCOIN_RPC_ERROR' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ── Tests: per-node retry ─────────────────────────────────────────────────────

describe('BitcoinRpcClient — per-node retry', () => {
  it('retries the same node up to maxAttempts before failing over', async () => {
    const node1 = makeNode('http://node1:8332', { maxAttempts: 2, retryDelayMs: 0 });
    const node2 = makeNode('http://node2:8332', { maxAttempts: 1 });
    const client = new BitcoinRpcClient(makeSelector([node1, node2]));

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))   // node1 attempt 1
      .mockRejectedValueOnce(new Error('timeout'))   // node1 attempt 2 → failover
      .mockResolvedValueOnce(okResponse(makeJsonRpcOk(1)));  // node2 succeeds

    const result = await client.call<number>('getblockcount');
    expect(result).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('uses per-node auth header built from node.user and node.password', async () => {
    const node = makeNode('http://node1:8332', { user: 'alice', password: 'wonderland' });
    const client = new BitcoinRpcClient(makeSelector([node]));

    let capturedAuth = '';
    (global.fetch as jest.Mock) = jest.fn((_url: string, opts: RequestInit) => {
      capturedAuth = (opts.headers as Record<string, string>)['Authorization'] ?? '';
      return Promise.resolve(okResponse(makeJsonRpcOk(null)));
    });

    await client.call('getblockchaininfo');
    const expected = `Basic ${Buffer.from('alice:wonderland').toString('base64')}`;
    expect(capturedAuth).toBe(expected);
  });

  it('omits Authorization header when user is undefined', async () => {
    const node = makeNode('http://node1:8332', { user: undefined, password: undefined });
    const client = new BitcoinRpcClient(makeSelector([node]));

    let capturedHeaders: Record<string, string> = {};
    (global.fetch as jest.Mock) = jest.fn((_url: string, opts: RequestInit) => {
      capturedHeaders = opts.headers as Record<string, string>;
      return Promise.resolve(okResponse(makeJsonRpcOk(null)));
    });

    await client.call('getblockchaininfo');
    expect(capturedHeaders['Authorization']).toBeUndefined();
  });
});
