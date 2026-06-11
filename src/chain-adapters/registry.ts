import { IChainAdapter } from './types';
import { BitcoinAdapter } from './bitcoin/adapter';
import { EthereumAdapter } from './ethereum/adapter';
import { TronAdapter } from './tron/adapter';
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

// BTC adapter — always registered
adapterRegistry.register(new BitcoinAdapter());

// ETH adapter — registered when ETH_NODE_URL is configured
// Ethereum support is disabled by default (chain.is_enabled = 0 in DB).
// Enable via: PATCH /admin/v1/chains/ethereum { isEnabled: true } + set ETH_NODE_URL
if (config.ETH_NODE_URL) {
  adapterRegistry.register(new EthereumAdapter(config.ETH_NODE_URL, config.ETH_NODE_AUTH));
}

// TRON adapter — registered only for local/self-hosted TRON nodes.
// TronGrid/hosted third-party APIs are intentionally unsupported.
if (config.TRON_NODE_URL) {
  adapterRegistry.register(new TronAdapter(config.TRON_NODE_URL));
}
