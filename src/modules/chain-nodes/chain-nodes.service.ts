import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { NotFoundError, ConflictError, ValidationError } from '../../shared/errors/index';
import { logger } from '../../shared/logging/index';
import { toUnixTs } from '../../shared/time/index';
import { ticklerService } from '../../shared/tickler/tickler.service';

export type ChainNodeRole = 'full' | 'broadcast_only';
export type ChainNodeStatus = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

export interface ChainNode {
  id: string;
  chain_id: string;
  tenant_id: string | null;
  label: string;
  rpc_url: string;
  rpc_user: string | null;
  rpc_password_ref: string | null;
  network: string;
  role: ChainNodeRole;
  priority: number;
  timeout_ms: number;
  max_attempts: number;
  retry_delay_ms: number;
  is_enabled: number;
  status: ChainNodeStatus;
  block_height: number | null;
  last_checked_at: string | null;
  last_healthy_at: string | null;
  last_error: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateChainNodeInput {
  chainId: string;
  tenantId?: string | null;
  label: string;
  rpcUrl: string;
  rpcUser?: string | null;
  rpcPasswordRef?: string | null;
  network?: string;
  role?: ChainNodeRole;
  priority?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateChainNodeInput {
  label?: string;
  rpcUrl?: string;
  rpcUser?: string;
  rpcPasswordRef?: string;
  role?: ChainNodeRole;
  priority?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  isEnabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

function toApi(row: ChainNode) {
  return {
    id: row.id,
    chainId: row.chain_id,
    tenantId: row.tenant_id,
    label: row.label,
    rpcUrl: row.rpc_url,
    rpcUser: row.rpc_user,
    // Never expose rpc_password_ref in API responses
    network: row.network,
    role: row.role,
    priority: row.priority,
    timeoutMs: row.timeout_ms,
    maxAttempts: row.max_attempts,
    retryDelayMs: row.retry_delay_ms,
    isEnabled: row.is_enabled === 1,
    status: row.status,
    blockHeight: row.block_height,
    lastCheckedAt: row.last_checked_at ? toUnixTs(row.last_checked_at) : null,
    lastHealthyAt: row.last_healthy_at ? toUnixTs(row.last_healthy_at) : null,
    lastError: row.last_error,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: toUnixTs(row.created_at),
    updatedAt: toUnixTs(row.updated_at),
  };
}

export const chainNodesService = {
  async create(input: CreateChainNodeInput, actorLogin: string) {
    const db = getDbClient();
    const id = `node_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    // Validate rpcPasswordRef format — only when provided (TRON nodes have no auth)
    if (input.rpcPasswordRef != null &&
        !input.rpcPasswordRef.startsWith('env:') && !input.rpcPasswordRef.startsWith('aes256:')) {
      throw new ValidationError('rpcPasswordRef must start with "env:" or "aes256:"');
    }

    await db.run(`
      INSERT INTO chain_nodes (
        id, chain_id, tenant_id, label, rpc_url, rpc_user, rpc_password_ref,
        network, role, priority, timeout_ms, max_attempts, retry_delay_ms,
        is_enabled, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'unknown', ?, ?, ?)
    `, [
      id, input.chainId, input.tenantId ?? null, input.label,
      input.rpcUrl, input.rpcUser ?? null, input.rpcPasswordRef ?? null,
      input.network ?? 'mainnet',
      input.role ?? 'full',
      input.priority ?? 100,
      input.timeoutMs ?? 10000,
      input.maxAttempts ?? 3,
      input.retryDelayMs ?? 1000,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now, now,
    ]);

    const node = await this.getByIdInternal(id);
    ticklerService.record({
      tenantId: input.tenantId ?? null,
      category: 'platform',
      subcategory: 'chain_node.created',
      entityId: id,
      actorLogin,
      field1: input.chainId,
      field2: input.rpcUrl,
      field3: input.role ?? 'full',
      newValue: node,
    });

    logger.info('Chain node created', { id, chainId: input.chainId, label: input.label });
    return toApi(node);
  },

  async list(filters: { chainId?: string; tenantId?: string | null; isEnabled?: boolean }) {
    const db = getDbClient();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.chainId) {
      conditions.push('chain_id = ?');
      params.push(filters.chainId);
    }
    if (filters.tenantId !== undefined) {
      if (filters.tenantId === null) {
        conditions.push('tenant_id IS NULL');
      } else {
        conditions.push('(tenant_id = ? OR tenant_id IS NULL)');
        params.push(filters.tenantId);
      }
    }
    if (filters.isEnabled !== undefined) {
      conditions.push('is_enabled = ?');
      params.push(filters.isEnabled ? 1 : 0);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.all<ChainNode>(`
      SELECT * FROM chain_nodes ${where} ORDER BY chain_id, priority ASC
    `, params);

    return rows.map(toApi);
  },

  async getById(id: string) {
    const node = await this.getByIdInternal(id);
    return toApi(node);
  },

  async getByIdInternal(id: string): Promise<ChainNode> {
    const db = getDbClient();
    const row = await db.get<ChainNode>('SELECT * FROM chain_nodes WHERE id = ?', [id]);
    if (!row) throw new NotFoundError(`Chain node not found: ${id}`);
    return row;
  },

  async update(id: string, input: UpdateChainNodeInput, actorLogin: string) {
    const db = getDbClient();
    const existing = await this.getByIdInternal(id);
    const now = new Date().toISOString();

    if (input.rpcPasswordRef !== undefined) {
      if (!input.rpcPasswordRef.startsWith('env:') && !input.rpcPasswordRef.startsWith('aes256:')) {
        throw new ValidationError('rpcPasswordRef must start with "env:" or "aes256:"');
      }
    }

    const fields: string[] = [];
    const params: unknown[] = [];

    if (input.label !== undefined)          { fields.push('label = ?');           params.push(input.label); }
    if (input.rpcUrl !== undefined)         { fields.push('rpc_url = ?');          params.push(input.rpcUrl); }
    if (input.rpcUser !== undefined)        { fields.push('rpc_user = ?');         params.push(input.rpcUser); }
    if (input.rpcPasswordRef !== undefined) { fields.push('rpc_password_ref = ?'); params.push(input.rpcPasswordRef); }
    if (input.role !== undefined)           { fields.push('role = ?');             params.push(input.role); }
    if (input.priority !== undefined)       { fields.push('priority = ?');         params.push(input.priority); }
    if (input.timeoutMs !== undefined)      { fields.push('timeout_ms = ?');       params.push(input.timeoutMs); }
    if (input.maxAttempts !== undefined)    { fields.push('max_attempts = ?');     params.push(input.maxAttempts); }
    if (input.retryDelayMs !== undefined)   { fields.push('retry_delay_ms = ?');   params.push(input.retryDelayMs); }
    if (input.isEnabled !== undefined)      { fields.push('is_enabled = ?');       params.push(input.isEnabled ? 1 : 0); }
    if (input.metadata !== undefined)       { fields.push('metadata = ?');         params.push(input.metadata ? JSON.stringify(input.metadata) : null); }

    if (fields.length === 0) return toApi(existing);

    fields.push('updated_at = ?');
    params.push(now, id);

    await db.run(`UPDATE chain_nodes SET ${fields.join(', ')} WHERE id = ?`, params);

    const updated = await this.getByIdInternal(id);
    ticklerService.record({
      tenantId: existing.tenant_id,
      category: 'platform',
      subcategory: 'chain_node.updated',
      entityId: id,
      actorLogin,
      prevValue: existing,
      newValue: updated,
    });

    return toApi(updated);
  },

  async updateHealthStatus(id: string, status: ChainNodeStatus, blockHeight: number | null, error: string | null): Promise<void> {
    const db = getDbClient();
    const now = new Date().toISOString();
    await db.run(`
      UPDATE chain_nodes
      SET status = ?, block_height = ?, last_checked_at = ?,
          last_healthy_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_healthy_at END,
          last_error = ?, updated_at = ?
      WHERE id = ?
    `, [status, blockHeight, now, status, now, error, now, id]);
  },

  async resolvePassword(id: string): Promise<string | null> {
    const db = getDbClient();
    const row = await db.get<{ rpc_password_ref: string | null }>(
      'SELECT rpc_password_ref FROM chain_nodes WHERE id = ?',
      [id]
    );
    if (!row) throw new NotFoundError(`Chain node not found: ${id}`);
    const ref = row.rpc_password_ref;
    if (ref == null) return null;  // TRON or other open-HTTP chains
    if (ref.startsWith('env:')) {
      const varName = ref.slice(4);
      const val = process.env[varName];
      if (!val) throw new Error(`Secret env var not set: ${varName}`);
      return val;
    }
    throw new Error(`Unsupported rpc_password_ref format: ${ref}`);
  },

  async getHealthyNodes(chainId: string, role?: ChainNodeRole): Promise<ChainNode[]> {
    const db = getDbClient();
    const roleClause = role ? 'AND role = ?' : '';
    const params: unknown[] = [chainId];
    if (role) params.push(role);
    const rows = await db.all<ChainNode>(`
      SELECT * FROM chain_nodes
      WHERE chain_id = ? AND is_enabled = 1 AND status IN ('healthy', 'unknown')
      ${roleClause}
      ORDER BY priority ASC
    `, params);
    return rows;
  },

  // ---------------------------------------------------------------------------
  // Tenant-scoped methods (FAZA 4 — tenant-owned nodes)
  // ---------------------------------------------------------------------------

  async getByIdForTenant(id: string, tenantId: string) {
    const node = await this.getByIdInternal(id);
    if (node.tenant_id !== null && node.tenant_id !== tenantId) {
      throw new NotFoundError(`Chain node not found: ${id}`);
    }
    return toApi(node);
  },

  async getByIdInternalForTenant(id: string, tenantId: string): Promise<ChainNode> {
    const node = await this.getByIdInternal(id);
    if (node.tenant_id !== null && node.tenant_id !== tenantId) {
      throw new NotFoundError(`Chain node not found: ${id}`);
    }
    return node;
  },

  async updateForTenant(id: string, tenantId: string, input: UpdateChainNodeInput, actorLogin: string) {
    const existing = await this.getByIdInternalForTenant(id, tenantId);
    if (existing.tenant_id === null) {
      throw new ValidationError('Platform nodes cannot be modified by tenants');
    }
    return this.update(id, input, actorLogin);
  },

  async deleteForTenant(id: string, tenantId: string, actorLogin: string): Promise<void> {
    const existing = await this.getByIdInternalForTenant(id, tenantId);
    if (existing.tenant_id === null) {
      throw new ValidationError('Platform nodes cannot be deleted by tenants');
    }
    const db = getDbClient();
    const now = new Date().toISOString();
    await db.run('DELETE FROM chain_nodes WHERE id = ?', [id]);
    ticklerService.record({
      tenantId,
      category: 'platform',
      subcategory: 'chain_node.deleted',
      entityId: id,
      actorLogin,
      field1: existing.chain_id,
      prevValue: existing,
    });
  },

  async setPrimaryForTenant(nodeId: string, tenantId: string, actorLogin: string) {
    const node = await this.getByIdInternalForTenant(nodeId, tenantId);
    const db = getDbClient();
    const now = new Date().toISOString();

    // Atomic: demote existing primary → set new primary
    await db.transaction(async (tx) => {
      await tx.run(`
        UPDATE chain_nodes SET role = 'full', updated_at = ?
        WHERE tenant_id = ? AND chain_id = ? AND role = 'full' AND id != ?
      `, [now, tenantId, node.chain_id, nodeId]);
      await tx.run(`
        UPDATE chain_nodes SET role = 'full', priority = 1, updated_at = ?
        WHERE id = ?
      `, [now, nodeId]);
    });

    ticklerService.record({
      tenantId,
      category: 'platform',
      subcategory: 'chain_node.set_primary',
      entityId: nodeId,
      actorLogin,
      field1: node.chain_id,
    });

    return this.getById(nodeId);
  },
};
