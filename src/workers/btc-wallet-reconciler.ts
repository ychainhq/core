import { logger } from '../shared/logging/index';

/**
 * @deprecated v3: Bitcoin Core nodes are now stateless — no FWallet management.
 * Deposit detection is handled by btc-indexer (packages/btc-indexer) which
 * writes to chain_events. This function is a no-op and will be removed in FAZA 2.
 */
export async function reconcileBtcWallets(): Promise<void> {
  logger.debug('reconcileBtcWallets: no-op in v3 (btc-indexer handles deposit detection)');
}
