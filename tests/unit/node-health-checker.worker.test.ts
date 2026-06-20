/**
 * NodeHealthCheckerWorker unit tests.
 *
 * Key behaviour under test: the `initialblockdownload` handling.
 * In regtest, IBD=true means the chain tip is >24 h old — normal in dev
 * environments where blocks are mined on demand. The worker must NOT
 * mark regtest nodes as degraded just because of an old tip.
 * On mainnet/testnet, IBD=true is a real sync-in-progress signal → degraded.
 */

jest.mock('../../src/modules/chain-nodes/chain-nodes.service', () => ({
  chainNodesService: {
    list:               jest.fn(),
    resolvePassword:    jest.fn().mockResolvedValue('bitcoin'),
    updateHealthStatus: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../src/config/index', () => ({ config: {} }));

import { NodeHealthCheckerWorker } from '../../src/workers/node-health-checker.worker';
import { chainNodesService } from '../../src/modules/chain-nodes/chain-nodes.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(id = 'node_test') {
  return { id, rpcUrl: 'http://btc-node:18443', rpcUser: 'bitcoin', chainId: 'bitcoin' };
}

function makeTronNode(id = 'node_tron') {
  return { id, rpcUrl: 'http://tron-node:8090', rpcUser: null, chainId: 'tron' };
}

function mockRpcResponse(result: Record<string, unknown>) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ result, error: null }),
  }) as jest.Mock;
}

function mockRpcError(status = 503) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  }) as jest.Mock;
}

function mockFetchThrows(message = 'connection refused') {
  global.fetch = jest.fn().mockRejectedValue(new Error(message)) as jest.Mock;
}

function capturedStatus() {
  return (chainNodesService.updateHealthStatus as jest.Mock).mock.calls[0]?.[1] as string;
}
function capturedError() {
  return (chainNodesService.updateHealthStatus as jest.Mock).mock.calls[0]?.[3] as string | null;
}

beforeEach(() => {
  jest.clearAllMocks();
  (chainNodesService.list as jest.Mock).mockResolvedValue([makeNode()]);
});

// ─── IBD × network matrix ─────────────────────────────────────────────────────

describe('initialblockdownload handling', () => {
  test('regtest + IBD=true → healthy (old tip is normal in dev)', async () => {
    mockRpcResponse({ blocks: 133, chain: 'regtest', initialblockdownload: true });
    await new NodeHealthCheckerWorker().run();
    expect(capturedStatus()).toBe('healthy');
    expect(capturedError()).toBeNull();
  });

  test('regtest + IBD=false → healthy', async () => {
    mockRpcResponse({ blocks: 133, chain: 'regtest', initialblockdownload: false });
    await new NodeHealthCheckerWorker().run();
    expect(capturedStatus()).toBe('healthy');
  });

  test('mainnet + IBD=true → degraded (real sync in progress)', async () => {
    mockRpcResponse({ blocks: 800000, chain: 'main', initialblockdownload: true });
    await new NodeHealthCheckerWorker().run();
    expect(capturedStatus()).toBe('degraded');
    expect(capturedError()).toMatch(/initial block download/i);
  });

  test('testnet + IBD=true → degraded', async () => {
    mockRpcResponse({ blocks: 2000000, chain: 'test', initialblockdownload: true });
    await new NodeHealthCheckerWorker().run();
    expect(capturedStatus()).toBe('degraded');
    expect(capturedError()).toMatch(/initial block download/i);
  });

  test('mainnet + IBD=false → healthy', async () => {
    mockRpcResponse({ blocks: 800000, chain: 'main', initialblockdownload: false });
    await new NodeHealthCheckerWorker().run();
    expect(capturedStatus()).toBe('healthy');
    expect(capturedError()).toBeNull();
  });
});

// ─── Other health outcomes ─────────────────────────────────────────────────────

describe('other health outcomes', () => {
  test('non-200 HTTP response (not 500) → unreachable', async () => {
    mockRpcError(503);
    await new NodeHealthCheckerWorker().run();
    expect(capturedStatus()).toBe('unreachable');
  });

  test('fetch throws (network error) → unreachable', async () => {
    mockFetchThrows('ECONNREFUSED');
    await new NodeHealthCheckerWorker().run();
    expect(capturedStatus()).toBe('unreachable');
    expect(capturedError()).toMatch(/ECONNREFUSED/);
  });

  test('RPC returns error object → unreachable', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: null, error: { code: -28, message: 'Loading block index…' } }),
    }) as jest.Mock;
    await new NodeHealthCheckerWorker().run();
    expect(capturedStatus()).toBe('unreachable');
  });

  test('blockHeight is extracted from blocks field', async () => {
    mockRpcResponse({ blocks: 133, chain: 'regtest', initialblockdownload: false });
    await new NodeHealthCheckerWorker().run();
    const blockHeight = (chainNodesService.updateHealthStatus as jest.Mock).mock.calls[0][2];
    expect(blockHeight).toBe(133);
  });

  test('TRON nodes use getnowblock endpoint and extract block height', async () => {
    (chainNodesService.list as jest.Mock).mockResolvedValue([makeTronNode()]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ block_header: { raw_data: { number: 456 } } }),
    }) as jest.Mock;

    await new NodeHealthCheckerWorker().run();

    expect(global.fetch).toHaveBeenCalledWith('http://tron-node:8090/wallet/getnowblock', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(capturedStatus()).toBe('healthy');
    expect((chainNodesService.updateHealthStatus as jest.Mock).mock.calls[0][2]).toBe(456);
  });

  test('no enabled nodes → updateHealthStatus not called', async () => {
    (chainNodesService.list as jest.Mock).mockResolvedValue([]);
    await new NodeHealthCheckerWorker().run();
    expect(chainNodesService.updateHealthStatus).not.toHaveBeenCalled();
  });
});
