/**
 * Tenant-owned chain nodes API (FAZA 4)
 *
 * Tenants can register and manage their own Bitcoin Core (or future ETH) nodes.
 * A tenant's own nodes take priority over platform nodes for their wallets.
 *
 * Security: tenant_id is always injected from auth middleware — tenants cannot
 * access or modify other tenants' nodes.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { chainNodesService } from './chain-nodes.service';
import { resolveActorLogin } from '../../shared/tickler/tickler.actor';

export const tenantChainNodesRouter = Router();

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

function actor(req: Request): string {
  return resolveActorLogin(req) ?? 'tenant:unknown';
}

const createSchema = z.object({
  chainId: z.string().min(1),
  label: z.string().min(1).max(200),
  rpcUrl: z.string().url(),
  rpcUser: z.string().min(1),
  rpcPasswordRef: z.string().min(1).refine(
    v => v.startsWith('env:') || v.startsWith('aes256:'),
    'rpcPasswordRef must start with "env:" or "aes256:"'
  ),
  network: z.enum(['mainnet', 'testnet', 'regtest']).optional(),
  role: z.enum(['full', 'broadcast_only']).optional(),
  priority: z.coerce.number().int().min(1).max(9999).optional(),
  timeoutMs: z.coerce.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  rpcUrl: z.string().url().optional(),
  rpcUser: z.string().min(1).optional(),
  rpcPasswordRef: z.string().min(1).optional(),
  role: z.enum(['full', 'broadcast_only']).optional(),
  priority: z.coerce.number().int().min(1).max(9999).optional(),
  isEnabled: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

// POST /v1/chain-nodes — tenant registers their own node
tenantChainNodesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createSchema.parse(req.body);
    const node = await chainNodesService.create(
      { ...body, tenantId: tenantId(req) },
      actor(req)
    );
    res.status(201).json({ data: node });
  } catch (err) { next(err); }
});

// GET /v1/chain-nodes — list tenant's own nodes + platform nodes
tenantChainNodesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nodes = await chainNodesService.list({ tenantId: tenantId(req) });
    res.json({ data: nodes });
  } catch (err) { next(err); }
});

// GET /v1/chain-nodes/:nodeId
tenantChainNodesRouter.get('/:nodeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const node = await chainNodesService.getByIdForTenant(req.params.nodeId, tenantId(req));
    res.json({ data: node });
  } catch (err) { next(err); }
});

// PATCH /v1/chain-nodes/:nodeId — tenant updates their own node
tenantChainNodesRouter.patch('/:nodeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateSchema.parse(req.body);
    const node = await chainNodesService.updateForTenant(
      req.params.nodeId,
      tenantId(req),
      body as any,
      actor(req)
    );
    res.json({ data: node });
  } catch (err) { next(err); }
});

// DELETE /v1/chain-nodes/:nodeId — remove tenant's node
tenantChainNodesRouter.delete('/:nodeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await chainNodesService.deleteForTenant(req.params.nodeId, tenantId(req), actor(req));
    res.status(204).end();
  } catch (err) { next(err); }
});

// POST /v1/chain-nodes/:nodeId/set-primary — set this node as primary for chain
tenantChainNodesRouter.post('/:nodeId/set-primary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const node = await chainNodesService.setPrimaryForTenant(
      req.params.nodeId,
      tenantId(req),
      actor(req)
    );
    res.json({ data: node });
  } catch (err) { next(err); }
});

// POST /v1/chain-nodes/:nodeId/test-connection — test connectivity
tenantChainNodesRouter.post('/:nodeId/test-connection', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const node = await chainNodesService.getByIdInternalForTenant(req.params.nodeId, tenantId(req));
    const password = await chainNodesService.resolvePassword(node.id);
    const auth = Buffer.from(`${node.rpc_user}:${password}`).toString('base64');

    let fetchResponse: globalThis.Response;
    try {
      fetchResponse = await fetch(node.rpc_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        body: JSON.stringify({ jsonrpc: '1.1', id: 'test', method: 'getblockchaininfo', params: [] }),
        signal: AbortSignal.timeout(node.timeout_ms),
      });
    } catch (fetchErr) {
      res.status(422).json({ error: { code: 'RPC_UNREACHABLE', message: String(fetchErr) } });
      return;
    }

    const data = await fetchResponse.json() as any;
    if (data.error) {
      res.status(422).json({ error: { code: 'RPC_ERROR', message: data.error.message } });
      return;
    }
    res.json({ data: { ok: true, chain: data.result?.chain, blocks: data.result?.blocks } });
  } catch (err) { next(err); }
});
