import { IChainAdapter } from './types';
import { BitcoinAdapter } from './bitcoin/adapter';
import { EthereumAdapter } from './ethereum/adapter';
import { TronAdapter } from './tron/adapter';
import { NodeSelector, SelectedNode } from './node-selector';
import { ApiError } from '../shared/errors/index';
import { config } from '../config/index';

class AdapterRegistry {
  private adapters = new Map<string, IChainAdapter>();

  register(adapter: IChainAdapter): void {
    this.adapters.set(adapter.chain, adapter);
  }

  get(chain: string): IChainAdapter {
    const adapter = this.adapters.get(chain);
    if (!adapter) {
      throw new ApiError(404, 'CHAIN_NOT_SUPPORTED', `Chain '${chain}' is not supported`);
    }
    return adapter;
  }

  has(chain: string): boolean {
    return this.adapters.has(chain);
  }

  list(): string[] {
    return Array.from(this.adapters.keys());
  }
}

export const adapterRegistry = new AdapterRegistry();

// ── BTC adapter — always registered ──────────────────────────────────────────
// Falls back to BITCOIN_RPC_URL env var when chain_nodes is empty.
// NodeSelector queries chain_nodes DB on each RPC call (10s TTL cache) and
// returns nodes in priority ASC order for priority-aware failover.
//
// btcNodeSelector is exported so that service/worker code that creates
// BitcoinAdapter instances directly (not via the registry) can share the
// same cached node list rather than creating independent selectors.
const btcFallback: SelectedNode = {
  url: config.BITCOIN_RPC_URL,
  user: config.BITCOIN_RPC_USER,
  password: config.BITCOIN_RPC_PASSWORD,
  timeoutMs: config.BITCOIN_RPC_TIMEOUT_MS,
  maxAttempts: config.BITCOIN_RPC_MAX_ATTEMPTS,
  retryDelayMs: config.BITCOIN_RPC_RETRY_DELAY_MS,
};
export const btcNodeSelector = new NodeSelector('bitcoin', btcFallback);
adapterRegistry.register(new BitcoinAdapter(btcNodeSelector));

// ── ETH adapter — registered when ETH_NODE_URL is configured ─────────────────
// Ethereum support is disabled by default (chain.is_enabled = 0 in DB).
// Enable via: PATCH /admin/v1/chains/ethereum { isEnabled: true } + set ETH_NODE_URL
if (config.ETH_NODE_URL) {
  adapterRegistry.register(new EthereumAdapter(config.ETH_NODE_URL, config.ETH_NODE_AUTH));
}

// ── TRON adapter — always registered, nodes sourced from chain_nodes DB ──────
// Falls back to TRON_NODE_URL env var when chain_nodes has no TRON entries.
// If neither chain_nodes nor TRON_NODE_URL is configured, RPC calls throw
// ApiError(503, 'TRON_NO_NODES') so callers can surface a meaningful error.
const tronFallback: SelectedNode | null = config.TRON_NODE_URL
  ? {
      url: config.TRON_NODE_URL,
      timeoutMs: 15_000,
      maxAttempts: 3,
      retryDelayMs: 1_000,
    }
  : null;
adapterRegistry.register(new TronAdapter(new NodeSelector('tron', tronFallback)));
