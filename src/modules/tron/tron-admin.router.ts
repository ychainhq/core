import { Router, Request, Response, NextFunction } from 'express';
import { getDbClient } from '../../db/client';

export const tronAdminRouter = Router();

/**
 * GET /admin/v1/tron/sweep-queue-stats
 *
 * Returns sweep queue statistics across all tenants: total entries, breakdown by priority
 * and asset, and energy delegation counts. Useful for monitoring at 10M-scale.
 */
tronAdminRouter.get('/tron/sweep-queue-stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
  const db = getDbClient();

  const [queueStats, delegationStats] = await Promise.all([
    db.all<{ asset_id: string; priority: number; cnt: number }>(`
      SELECT asset_id, priority, COUNT(*) AS cnt
      FROM tron_sweep_queue
      GROUP BY asset_id, priority
      ORDER BY asset_id, priority DESC
    `),
    db.get<{ total: number; with_sweep: number }>(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN sweep_id IS NOT NULL THEN 1 ELSE 0 END) AS with_sweep
      FROM tron_energy_delegations
    `),
  ]);

  // Aggregate queue totals
  const queueByAsset: Record<string, { total: number; by_priority: Record<string, number> }> = {};
  let queueTotal = 0;

  for (const row of queueStats) {
    if (!queueByAsset[row.asset_id]) {
      queueByAsset[row.asset_id] = { total: 0, by_priority: {} };
    }
    queueByAsset[row.asset_id].total += row.cnt;
    queueByAsset[row.asset_id].by_priority[String(row.priority)] = row.cnt;
    queueTotal += row.cnt;
  }

    res.json({
      data: {
        sweep_queue: {
          total: queueTotal,
          by_asset: queueByAsset,
        },
        energy_delegations: {
          total: delegationStats?.total ?? 0,
          with_linked_sweep: delegationStats?.with_sweep ?? 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});
