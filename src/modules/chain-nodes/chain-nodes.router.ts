import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { chainNodesService } from './chain-nodes.service';
import { resolveActorLogin } from '../../shared/tickler/tickler.actor';
import { logger } from '../../shared/logging/index';

function actor(req: Request): string {
  return resolveActorLogin(req) ?? 'admin:unknown';
}

export const chainNodesAdminRouter = Router();

const createSchema = z.object({
  chainId: z.string().min(1),
  tenantId: z.string().optional().nullable(),
  label: z.string().min(1).max(200),
  rpcUrl: z.string().url(),
  // rpcUser and rpcPasswordRef are optional for chains that use open HTTP APIs (e.g. TRON).
  // Bitcoin Core nodes still require both.
  rpcUser: z.string().min(1).optional().nullable(),
  rpcPasswordRef: z.string().min(1).refine(
    v => v.startsWith('env:') || v.startsWith('aes256:'),
    'rpcPasswordRef must start with "env:" or "aes256:"'
  ).optional().nullable(),
  network: z.enum(['mainnet', 'testnet', 'regtest', 'private']).optional(),
  role: z.enum(['full', 'broadcast_only']).optional(),
  priority: z.coerce.number().int().min(1).max(9999).optional(),
  timeoutMs: z.coerce.number().int().positive().optional(),
  maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
  retryDelayMs: z.coerce.number().int().min(0).optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  rpcUrl: z.string().url().optional(),
  rpcUser: z.string().min(1).optional(),
  rpcPasswordRef: z.string().min(1).optional(),
  role: z.enum(['full', 'broadcast_only']).optional(),
  priority: z.coerce.number().int().min(1).max(9999).optional(),
  timeoutMs: z.coerce.number().int().positive().optional(),
  maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
  retryDelayMs: z.coerce.number().int().min(0).optional(),
  isEnabled: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const listQuerySchema = z.object({
  chainId: z.string().optional(),
  tenantId: z.string().optional(),
  isEnabled: z.enum(['true', 'false']).optional(),
});

// POST /admin/v1/chain-nodes
chainNodesAdminRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createSchema.parse(req.body);
    const node = await chainNodesService.create({ ...body, tenantId: body.tenantId ?? null }, actor(req));
    res.status(201).json({ data: node });
  } catch (err) {
    next(err);
  }
});

// GET /admin/v1/chain-nodes
chainNodesAdminRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const nodes = await chainNodesService.list({
      chainId: q.chainId,
      tenantId: q.tenantId,
      isEnabled: q.isEnabled !== undefined ? q.isEnabled === 'true' : undefined,
    });
    res.json({ data: nodes });
  } catch (err) {
    next(err);
  }
});

// GET /admin/v1/chain-nodes/:nodeId
chainNodesAdminRouter.get('/:nodeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const node = await chainNodesService.getById(req.params.nodeId);
    res.json({ data: node });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/v1/chain-nodes/:nodeId
chainNodesAdminRouter.patch('/:nodeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateSchema.parse(req.body);
    const node = await chainNodesService.update(req.params.nodeId, body as any, actor(req));
    res.json({ data: node });
  } catch (err) {
    next(err);
  }
});

// POST /admin/v1/chain-nodes/:nodeId/test-connection
// Verifies RPC connectivity without persisting any state changes.
chainNodesAdminRouter.post('/:nodeId/test-connection', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const node = await chainNodesService.getByIdInternal(req.params.nodeId);
    const password = await chainNodesService.resolvePassword(node.id);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (node.rpc_user != null && password != null) {
      headers['Authorization'] = `Basic ${Buffer.from(`${node.rpc_user}:${password}`).toString('base64')}`;
    }

    // TRON nodes use HTTP GET /wallet/getnowblock for health; BTC uses JSON-RPC POST
    const isTron = node.chain_id === 'tron';

    let fetchResponse: globalThis.Response;
    try {
      fetchResponse = isTron
        ? await fetch(`${node.rpc_url}/wallet/getnowblock`, {
            headers,
            signal: AbortSignal.timeout(node.timeout_ms),
          })
        : await fetch(node.rpc_url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '1.1', id: 'test', method: 'getblockchaininfo', params: [] }),
            signal: AbortSignal.timeout(node.timeout_ms),
          });
    } catch (fetchErr) {
      logger.warn('test-connection failed', { nodeId: req.params.nodeId, error: String(fetchErr) });
      res.status(422).json({ error: { code: 'RPC_UNREACHABLE', message: String(fetchErr) } });
      return;
    }

    if (!fetchResponse.ok && fetchResponse.status !== 500) {
      res.status(422).json({ error: { code: 'RPC_HTTP_ERROR', message: `HTTP ${fetchResponse.status}` } });
      return;
    }

    const data = await fetchResponse.json() as any;

    if (isTron) {
      // TRON /wallet/getnowblock returns { blockID, block_header: { raw_data: { number } } }
      const blockNumber = data?.block_header?.raw_data?.number ?? data?.number ?? null;
      res.json({ data: { ok: true, blocks: blockNumber } });
      return;
    }

    if (data.error) {
      res.status(422).json({ error: { code: 'RPC_ERROR', message: data.error.message } });
      return;
    }

    res.json({
      data: {
        ok: true,
        chain: data.result.chain,
        blocks: data.result.blocks,
        initialBlockDownload: data.result.initialblockdownload,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Tenant-facing router: read-only access to platform + own nodes
export const chainNodesTenantRouter = Router();

// GET /v1/chain-nodes — tenant sees platform nodes + their own
chainNodesTenantRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const nodes = await chainNodesService.list({ tenantId });
    res.json({ data: nodes });
  } catch (err) {
    next(err);
  }
});
