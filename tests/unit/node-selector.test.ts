/**
 * Unit tests — NodeSelector
 *
 * Verifies priority-ordered node resolution from chain_nodes DB,
 * env-var fallback when DB is empty, cache TTL behaviour, and
 * password-ref resolution.
 */

import { NodeSelector, SelectedNode } from '../../src/chain-adapters/node-selector';

// ── Mock chainNodesService (uses getDbClient internally) ─────────────────────
jest.mock('../../src/modules/chain-nodes/chain-nodes.service', () => ({
  chainNodesService: {
    getHealthyNodes: jest.fn(),
  },
}));

import { chainNodesService } from '../../src/modules/chain-nodes/chain-nodes.service';
const mockGetHealthyNodes = chainNodesService.getHealthyNodes as jest.MockedFunction<
  typeof chainNodesService.getHealthyNodes
>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const FALLBACK: SelectedNode = {
  url: 'http://fallback:8332',
  user: 'btcuser',
  password: 'btcpass',
  timeoutMs: 10_000,
  maxAttempts: 3,
  retryDelayMs: 1_000,
};

function makeDbNode(overrides: Partial<{
  id: string;
  rpc_url: string;
  rpc_user: string | null;
  rpc_password_ref: string | null;
  timeout_ms: number;
  max_attempts: number;
  retry_delay_ms: number;
  priority: number;
}> = {}) {
  return {
    id: 'node_aabbccdd',
    chain_id: 'bitcoin',
    tenant_id: null,
    label: 'Test Node',
    rpc_url: 'http://node1:8332',
    rpc_user: 'user1',
    rpc_password_ref: null,
    network: 'mainnet',
    role: 'full' as const,
    priority: 10,
    timeout_ms: 8_000,
    max_attempts: 2,
    retry_delay_ms: 500,
    is_enabled: 1,
    status: 'healthy' as const,
    block_height: null,
    last_checked_at: null,
    last_healthy_at: null,
    last_error: null,
    metadata: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('NodeSelector — DB-backed nodes', () => {
  it('returns nodes from DB in priority order', async () => {
    const node1 = makeDbNode({ id: 'node_1', rpc_url: 'http://node1:8332', priority: 20 });
    const node2 = makeDbNode({ id: 'node_2', rpc_url: 'http://node2:8332', priority: 10 });
    // DB query already returns sorted by priority ASC
    mockGetHealthyNodes.mockResolvedValue([node2, node1] as any);

    const selector = new NodeSelector('bitcoin', FALLBACK);
    const nodes = await selector.getNodes();

    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.url).toBe('http://node2:8332');
    expect(nodes[1]!.url).toBe('http://node1:8332');
  });

  it('maps DB node fields to SelectedNode correctly', async () => {
    mockGetHealthyNodes.mockResolvedValue([
      makeDbNode({ rpc_url: 'http://n1:8332', rpc_user: 'alice', timeout_ms: 5_000, max_attempts: 4, retry_delay_ms: 200 }),
    ] as any);

    const selector = new NodeSelector('bitcoin', null);
    const [node] = await selector.getNodes();

    expect(node!.url).toBe('http://n1:8332');
    expect(node!.user).toBe('alice');
    expect(node!.timeoutMs).toBe(5_000);
    expect(node!.maxAttempts).toBe(4);
    expect(node!.retryDelayMs).toBe(200);
  });

  it('resolves env: password ref at resolution time', async () => {
    process.env['TEST_BTC_PASS'] = 's3cr3t';
    mockGetHealthyNodes.mockResolvedValue([
      makeDbNode({ rpc_password_ref: 'env:TEST_BTC_PASS' }),
    ] as any);

    const selector = new NodeSelector('bitcoin', null);
    const [node] = await selector.getNodes();
    expect(node!.password).toBe('s3cr3t');
    delete process.env['TEST_BTC_PASS'];
  });

  it('skips node and uses fallback when env: var is missing', async () => {
    delete process.env['MISSING_VAR'];
    mockGetHealthyNodes.mockResolvedValue([
      makeDbNode({ rpc_password_ref: 'env:MISSING_VAR' }),
    ] as any);

    const selector = new NodeSelector('bitcoin', FALLBACK);
    const nodes = await selector.getNodes();
    // Bad node skipped → only fallback returned
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.url).toBe(FALLBACK.url);
  });

  it('skips individual bad node, returns the rest', async () => {
    process.env['TEST_GOOD_PASS'] = 'ok';
    mockGetHealthyNodes.mockResolvedValue([
      makeDbNode({ id: 'node_bad', rpc_password_ref: 'env:NONEXISTENT_VAR_XYZ' }),
      makeDbNode({ id: 'node_good', rpc_url: 'http://good:8332', rpc_password_ref: 'env:TEST_GOOD_PASS' }),
    ] as any);

    const selector = new NodeSelector('bitcoin', null);
    const nodes = await selector.getNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.url).toBe('http://good:8332');
    delete process.env['TEST_GOOD_PASS'];
  });

  it('skips node and uses fallback on unknown password ref format', async () => {
    mockGetHealthyNodes.mockResolvedValue([
      makeDbNode({ rpc_password_ref: 'unknown:format' }),
    ] as any);

    const selector = new NodeSelector('bitcoin', FALLBACK);
    const nodes = await selector.getNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.url).toBe(FALLBACK.url);
  });

  it('maps null rpc_user and null rpc_password_ref to undefined', async () => {
    mockGetHealthyNodes.mockResolvedValue([
      makeDbNode({ rpc_user: null, rpc_password_ref: null }),
    ] as any);

    const selector = new NodeSelector('tron', null);
    const [node] = await selector.getNodes();
    expect(node!.user).toBeUndefined();
    expect(node!.password).toBeUndefined();
  });
});

describe('NodeSelector — fallback behaviour', () => {
  it('returns env fallback when DB returns empty array', async () => {
    mockGetHealthyNodes.mockResolvedValue([]);

    const selector = new NodeSelector('bitcoin', FALLBACK);
    const nodes = await selector.getNodes();

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ url: FALLBACK.url, user: FALLBACK.user, password: FALLBACK.password });
  });

  it('returns env fallback when DB throws', async () => {
    mockGetHealthyNodes.mockRejectedValue(new Error('DB unavailable'));

    const selector = new NodeSelector('bitcoin', FALLBACK);
    const nodes = await selector.getNodes();

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.url).toBe(FALLBACK.url);
  });

  it('returns empty array when DB is empty and no fallback is set', async () => {
    mockGetHealthyNodes.mockResolvedValue([]);

    const selector = new NodeSelector('tron', null);
    const nodes = await selector.getNodes();

    expect(nodes).toHaveLength(0);
  });

  it('returns empty array when DB throws and no fallback is set', async () => {
    mockGetHealthyNodes.mockRejectedValue(new Error('DB unavailable'));

    const selector = new NodeSelector('tron', null);
    const nodes = await selector.getNodes();

    expect(nodes).toHaveLength(0);
  });
});

describe('NodeSelector — TTL cache', () => {
  it('caches results and does not re-query DB within TTL', async () => {
    mockGetHealthyNodes.mockResolvedValue([makeDbNode()] as any);

    const selector = new NodeSelector('bitcoin', null);
    await selector.getNodes();
    await selector.getNodes();

    expect(mockGetHealthyNodes).toHaveBeenCalledTimes(1);
  });

  it('re-queries DB after TTL expires', async () => {
    jest.useFakeTimers();
    mockGetHealthyNodes.mockResolvedValue([makeDbNode()] as any);

    const selector = new NodeSelector('bitcoin', null);
    await selector.getNodes();

    jest.advanceTimersByTime(11_000); // past 10s TTL
    await selector.getNodes();

    expect(mockGetHealthyNodes).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('queries DB for each chainId separately (no cross-chain cache bleed)', async () => {
    mockGetHealthyNodes.mockResolvedValue([makeDbNode()] as any);

    const btcSelector = new NodeSelector('bitcoin', null);
    const tronSelector = new NodeSelector('tron', null);

    await btcSelector.getNodes();
    await tronSelector.getNodes();

    expect(mockGetHealthyNodes).toHaveBeenCalledTimes(2);
    expect(mockGetHealthyNodes).toHaveBeenCalledWith('bitcoin');
    expect(mockGetHealthyNodes).toHaveBeenCalledWith('tron');
  });
});
