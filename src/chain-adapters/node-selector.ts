import { chainNodesService, ChainNode } from '../modules/chain-nodes/chain-nodes.service';
import { logger } from '../shared/logging/index';

export interface SelectedNode {
  url: string;
  user?: string;
  password?: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

const CACHE_TTL_MS = 10_000;

/**
 * Resolves the list of healthy nodes for a chain from chain_nodes (DB-backed),
 * falling back to a static env-var node when the DB is empty or unavailable.
 *
 * Nodes are returned in priority ASC order (lower number = higher priority).
 * Callers should try nodes in order and failover on connection errors.
 *
 * Password refs are resolved inline from env vars at resolution time so that
 * env var updates take effect without a restart (within the 10s cache TTL).
 */
export class NodeSelector {
  private cache: { nodes: SelectedNode[]; expiresAt: number } | null = null;

  constructor(
    readonly chainId: string,
    private readonly fallback: SelectedNode | null,
  ) {}

  async getNodes(): Promise<SelectedNode[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.nodes;
    }

    let rows: ChainNode[] = [];
    try {
      rows = await chainNodesService.getHealthyNodes(this.chainId);
    } catch (err) {
      logger.warn('NodeSelector: DB unavailable, using env fallback', {
        chainId: this.chainId,
        err: String(err),
      });
      const nodes = this.getFallback();
      this.cache = { nodes, expiresAt: now + CACHE_TTL_MS };
      return nodes;
    }

    // Map rows to SelectedNode, skipping individual nodes with bad config (e.g. missing env var).
    const dbNodes: SelectedNode[] = [];
    for (const row of rows) {
      try {
        dbNodes.push(mapChainNode(row));
      } catch (err) {
        logger.warn('NodeSelector: skipping node with unresolvable config', {
          nodeId: row.id,
          chainId: this.chainId,
          err: String(err),
        });
      }
    }

    const nodes = dbNodes.length > 0 ? dbNodes : this.getFallback();
    this.cache = { nodes, expiresAt: now + CACHE_TTL_MS };
    return nodes;
  }

  private getFallback(): SelectedNode[] {
    return this.fallback ? [this.fallback] : [];
  }
}

function mapChainNode(node: ChainNode): SelectedNode {
  return {
    url: node.rpc_url,
    user: node.rpc_user ?? undefined,
    password: resolvePasswordRef(node.rpc_password_ref),
    timeoutMs: node.timeout_ms,
    maxAttempts: node.max_attempts,
    retryDelayMs: node.retry_delay_ms,
  };
}

function resolvePasswordRef(ref: string | null): string | undefined {
  if (ref == null) return undefined;
  if (ref.startsWith('env:')) {
    const varName = ref.slice(4);
    const val = process.env[varName];
    if (!val) throw new Error(`Secret env var not set: ${varName}`);
    return val;
  }
  throw new Error(`Unsupported rpc_password_ref format: ${ref}`);
}
