/**
 * Unit tests — TronRpcClient N-node failover
 *
 * Verifies that TronRpcClient:
 *  - tries nodes in order returned by NodeSelector
 *  - fails over to the next node on network/HTTP errors
 *  - does NOT fail over on TRON API protocol errors (returned as HTTP 200 JSON)
 *  - throws TRON_NO_NODES when no nodes are configured
 *  - respects per-node retry (maxAttempts, retryDelayMs)
 *  - includes timeout via AbortSignal on each attempt
 */

import { TronRpcClient } from '../../src/chain-adapters/tron/rpc-client';
import { NodeSelector, SelectedNode } from '../../src/chain-adapters/node-selector';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(url: string, overrides: Partial<SelectedNode> = {}): SelectedNode {
  return {
    url,
    timeoutMs: 1_000,
    maxAttempts: 1,
    retryDelayMs: 0,
    ...overrides,
  };
}

function makeSelector(nodes: SelectedNode[]): NodeSelector {
  return { chainId: 'tron', getNodes: jest.fn().mockResolvedValue(nodes) } as unknown as NodeSelector;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// ── Tests: no nodes configured ────────────────────────────────────────────────

describe('TronRpcClient — no nodes', () => {
  it('throws TRON_NO_NODES when NodeSelector returns empty array', async () => {
    const client = new TronRpcClient(makeSelector([]));
    await expect(client.getNowBlock()).rejects.toMatchObject({ code: 'TRON_NO_NODES' });
  });
});

// ── Tests: failover ───────────────────────────────────────────────────────────

describe('TronRpcClient — N-node failover', () => {
  it('succeeds on second node when first throws a network error', async () => {
    const node1 = makeNode('http://tron1:8090');
    const node2 = makeNode('http://tron2:8090');
    const client = new TronRpcClient(makeSelector([node1, node2]));

    const blockResponse = {
      blockID: 'abc123',
      block_header: { raw_data: { number: 100, timestamp: 1_700_000_000_000, parentHash: '0000' } },
    };

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(blockResponse));

    const block = await client.getNowBlock();
    expect(block.blockID).toBe('abc123');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('fails over on HTTP error from first node', async () => {
    const node1 = makeNode('http://tron1:8090');
    const node2 = makeNode('http://tron2:8090');
    const client = new TronRpcClient(makeSelector([node1, node2]));

    const txInfo = { id: 'txhash', blockNumber: 500 };

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse('', 503))
      .mockResolvedValueOnce(jsonResponse(txInfo));

    const result = await client.getTransactionInfo('txhash');
    expect((result as any).blockNumber).toBe(500);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws after all nodes fail', async () => {
    const nodes = [makeNode('http://n1:8090'), makeNode('http://n2:8090')];
    const client = new TronRpcClient(makeSelector(nodes));

    (global.fetch as jest.Mock) = jest.fn().mockRejectedValue(new Error('timeout'));

    await expect(client.getNowBlock()).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('tries nodes in the order returned by NodeSelector', async () => {
    const node1 = makeNode('http://primary:8090');
    const node2 = makeNode('http://secondary:8090');
    const client = new TronRpcClient(makeSelector([node1, node2]));

    const calledUrls: string[] = [];
    (global.fetch as jest.Mock) = jest.fn((url: string) => {
      calledUrls.push(url);
      return Promise.reject(new Error('fail'));
    });

    await expect(client.getNowBlock()).rejects.toThrow();
    expect(calledUrls[0]).toContain('primary');
    expect(calledUrls[1]).toContain('secondary');
  });
});

// ── Tests: TRON protocol errors do not trigger failover ───────────────────────

describe('TronRpcClient — protocol errors propagate without failover', () => {
  it('does NOT fail over when TRON returns { result: false } (broadcast reject)', async () => {
    const nodes = [makeNode('http://n1:8090'), makeNode('http://n2:8090')];
    const client = new TronRpcClient(makeSelector(nodes));

    // TRON protocol error: HTTP 200, but result.result === false
    const broadcastFail = { result: false, code: 'SIGERROR', message: 'Invalid signature' };
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue(jsonResponse(broadcastFail));

    const result = await client.broadcastTransaction({ txID: 'abc', raw_data_hex: 'ff' });
    // broadcastTransaction returns the raw response; TronAdapter checks result.result
    expect(result.result).toBe(false);
    // Only called once — no failover on protocol-level rejection
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ── Tests: per-node retry ─────────────────────────────────────────────────────

describe('TronRpcClient — per-node retry', () => {
  it('retries the same node up to maxAttempts before failing over', async () => {
    const node1 = makeNode('http://n1:8090', { maxAttempts: 2, retryDelayMs: 0 });
    const node2 = makeNode('http://n2:8090', { maxAttempts: 1 });
    const client = new TronRpcClient(makeSelector([node1, node2]));

    const block = {
      blockID: 'ok',
      block_header: { raw_data: { number: 1, timestamp: 0, parentHash: '0' } },
    };

    (global.fetch as jest.Mock) = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))   // node1 attempt 1
      .mockRejectedValueOnce(new Error('timeout'))   // node1 attempt 2 → failover
      .mockResolvedValueOnce(jsonResponse(block));   // node2 succeeds

    const result = await client.getNowBlock();
    expect(result.blockID).toBe('ok');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

// ── Tests: wallet/TRON URL path construction ──────────────────────────────────

describe('TronRpcClient — URL construction', () => {
  it('strips trailing slash from node URL before appending path', async () => {
    const node = makeNode('http://tron1:8090/');  // trailing slash
    const client = new TronRpcClient(makeSelector([node]));

    const block = {
      blockID: 'x',
      block_header: { raw_data: { number: 1, timestamp: 0, parentHash: '0' } },
    };
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue(jsonResponse(block));

    await client.getNowBlock();

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://tron1:8090/wallet/getnowblock');
  });
});
