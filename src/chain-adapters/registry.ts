import { IChainAdapter } from './types';
import { BitcoinAdapter } from './bitcoin/adapter';
import { EthereumPlaceholderAdapter } from './ethereum-placeholder/adapter';
import { ApiError } from '../shared/errors/index';

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

// Register adapters
adapterRegistry.register(new BitcoinAdapter());
adapterRegistry.register(new EthereumPlaceholderAdapter());
