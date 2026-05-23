import { getDb } from '../db/sqlite';
import { BitcoinAdapter } from '../chain-adapters/bitcoin/adapter';
import { BatchImportEntry } from '../chain-adapters/types';
import { logger } from '../shared/logging/index';

/**
 * On startup: ensures every tenant's BTC Core wallet exists and all active
 * watched addresses are imported into it. Handles wallet resets gracefully.
 */
export async function reconcileBtcWallets(): Promise<void> {
  const db = getDb();
  const adapter = new BitcoinAdapter();

  const tenants = db.prepare('SELECT id FROM tenants WHERE status = ?').all('active') as { id: string }[];

  for (const { id: tenantId } of tenants) {
    try {
      await adapter.provisionTenantWallet(tenantId);
    } catch (err) {
      logger.warn('Failed to provision BTC wallet for tenant', { tenantId, error: String(err) });
      continue;
    }

    const watched = db
      .prepare("SELECT address, label, created_at FROM watched_addresses WHERE tenant_id = ? AND chain_id = 'bitcoin' AND is_active = 1")
      .all(tenantId) as { address: string; label: string | null; created_at: string }[];

    if (watched.length === 0) continue;

    const entries: BatchImportEntry[] = watched.map(({ address, label, created_at }) => ({
      address,
      label: label ?? '',
      timestampSec: Math.floor(new Date(created_at).getTime() / 1000),
    }));

    try {
      await adapter.batchImportAddresses(entries, tenantId);
      logger.info('BTC wallet reconciled', { tenantId, addressCount: entries.length });
    } catch (err) {
      logger.warn('Failed to batch-import watched addresses', { tenantId, error: String(err) });
    }
  }
}
