import { Router, Request, Response, NextFunction } from 'express';
import { clusterService } from './cluster.service';

export const clusterAdminRouter = Router();
export const clusterInternalRouter = Router();

// GET /admin/v1/cluster/status — live engine instances (monitoring only)
clusterAdminRouter.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const instances = await clusterService.listInstances();
    res.json({
      data: {
        instanceId: clusterService.instanceId,
        instances,
        note: 'Active-active mode: all instances run workers. No leader election.',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /internal/cluster/heartbeat — peer keep-alive notification
// No auth: internal only, must be firewalled at network level.
clusterInternalRouter.post('/heartbeat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { instanceId, engineUrl } = req.body as { instanceId: string; engineUrl: string };
    if (!instanceId || !engineUrl) {
      res.status(400).json({ error: 'instanceId and engineUrl required' });
      return;
    }

    const db = (await import('../../db/client')).getDbClient();
    const { config } = await import('../../config/index');
    const now = new Date().toISOString();

    await db.run(`
      INSERT INTO engine_instances (id, engine_url, started_at, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        engine_url   = excluded.engine_url,
        last_seen_at = excluded.last_seen_at,
        updated_at   = excluded.updated_at
    `, [instanceId, engineUrl, now, now, now, now]);

    res.json({ data: { accepted: true } });
  } catch (err) {
    next(err);
  }
});
