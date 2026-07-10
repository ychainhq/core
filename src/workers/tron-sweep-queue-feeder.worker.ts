import { getDbClient } from '../db/client';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

const INTERVAL_MS = 10_000;
const BATCH_SIZE = 500;

// Priority thresholds (multipliers of tenant threshold)
const PRIORITY_URGENT_MULTIPLIER = 10n;
const PRIORITY_HIGH_MULTIPLIER = 2n;

interface TenantThresholds {
  tenant_id: string;
  tron_usdt_sweep_threshold_sun: string | null;
  tron_sweep_threshold_sun: string | null;
  tron_trx_sweep_threshold_sun: string | null;
}

interface BalanceRow {
  address: string;
  tenant_id: string;
  asset_id: string;
  balance_raw: string;
}

/**
 * TronSweepQueueFeeder
 *
 * Runs every 10s. Scans `tron_account_balances` for deposit addresses whose
 * balance exceeds the configured threshold. Populates `tron_sweep_queue` with
 * a priority score. TronSweepWorker drains the queue using SKIP LOCKED.
 *
 * Key properties for 10M-scale:
 * - Only scans active tenants that have thresholds configured (O(active) not O(all))
 * - Batch limit (BATCH_SIZE=500) prevents runaway scans
 * - Upsert on PK (address, asset_id) — safe to run concurrently across instances
 * - Does not generate signing tasks — only populates the queue
 */
export class TronSweepQueueFeeder {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    if (!config.TRON_NODE_URL) {
      logger.info('TronSweepQueueFeeder: TRON_NODE_URL not configured — skipping');
      return;
    }
    logger.info('TronSweepQueueFeeder started', { intervalMs: INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('TronSweepQueueFeeder error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, INTERVAL_MS);

    setImmediate(() =>
      this.run().catch((err) => logger.error('TronSweepQueueFeeder initial run error', { error: String(err) }))
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('TronSweepQueueFeeder stopped');
    }
  }

  async run(): Promise<void> {
    const db = getDbClient();

    const tenants = await db.all<TenantThresholds>(`
      SELECT t.id AS tenant_id,
             tc.tron_usdt_sweep_threshold_sun,
             tc.tron_sweep_threshold_sun,
             tc.tron_trx_sweep_threshold_sun
      FROM tenants t
      JOIN tenant_configs tc ON tc.tenant_id = t.id
      WHERE t.status = 'active'
        AND tc.tron_xpub IS NOT NULL
        AND (
          tc.tron_usdt_sweep_threshold_sun IS NOT NULL
          OR tc.tron_sweep_threshold_sun IS NOT NULL
          OR tc.tron_trx_sweep_threshold_sun IS NOT NULL
        )
    `);

    if (tenants.length === 0) return;

    const tenantIds = tenants.map((t) => t.tenant_id);

    // Load balances for all active deposit addresses for these tenants in one query
    const placeholders = tenantIds.map(() => '?').join(',');
    const balances = await db.all<BalanceRow>(`
      SELECT tab.address, w.tenant_id, tab.asset_id, tab.balance_raw
      FROM tron_account_balances tab
      JOIN addresses a ON a.address = tab.address
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id IN (${placeholders})
        AND w.wallet_role = 'customer_deposits'
        AND a.chain_id = 'tron'
        AND a.status = 'active'
        AND CAST(tab.balance_raw AS INTEGER) > 0
      LIMIT ?
    `, [...tenantIds, BATCH_SIZE]);

    if (balances.length === 0) return;

    const thresholdMap = new Map(tenants.map((t) => [t.tenant_id, t]));
    const now = new Date().toISOString();
    let queued = 0;

    for (const bal of balances) {
      const tCfg = thresholdMap.get(bal.tenant_id);
      if (!tCfg) continue;

      const threshold = resolveThreshold(bal.asset_id, tCfg);
      if (!threshold) continue;

      const balBig = BigInt(bal.balance_raw);
      if (balBig < threshold) continue;

      const priority = computePriority(balBig, threshold);

      // Upsert: if already queued, update balance+priority if higher (so urgent overtakes normal)
      await db.run(`
        INSERT INTO tron_sweep_queue (address, tenant_id, asset_id, estimated_balance_raw, priority, queued_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(address, asset_id) DO UPDATE SET
          estimated_balance_raw = excluded.estimated_balance_raw,
          priority = MAX(tron_sweep_queue.priority, excluded.priority),
          queued_at = CASE
            WHEN excluded.priority > tron_sweep_queue.priority THEN excluded.queued_at
            ELSE tron_sweep_queue.queued_at
          END
      `, [bal.address, bal.tenant_id, bal.asset_id, bal.balance_raw, priority, now]);

      queued++;
    }

    if (queued > 0) {
      logger.debug('TronSweepQueueFeeder: queued entries', { queued, total: balances.length });
    }
  }
}

function resolveThreshold(assetId: string, cfg: TenantThresholds): bigint | null {
  if (assetId === 'tron:USDT') {
    const raw = cfg.tron_usdt_sweep_threshold_sun ?? cfg.tron_sweep_threshold_sun;
    return raw ? BigInt(raw) : null;
  }
  if (assetId === 'tron:TRX') {
    const raw = cfg.tron_trx_sweep_threshold_sun;
    return raw ? BigInt(raw) : null;
  }
  return null;
}

function computePriority(balance: bigint, threshold: bigint): number {
  if (balance >= threshold * PRIORITY_URGENT_MULTIPLIER) return 2;
  if (balance >= threshold * PRIORITY_HIGH_MULTIPLIER) return 1;
  return 0;
}
