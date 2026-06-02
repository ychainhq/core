/// <reference path="../../types/express.d.ts" />
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { getDbClient } from '../../db/client';
import { UnauthorizedError } from '../errors/index';

interface ApiKeyRow {
  id: string;
  tenant_id: string | null;
  key_hash: string;
  name: string;
  is_active: number;
  expires_at: string | null;
}

interface TenantRow {
  id: string;
  status: string;
}

export interface TenantAuthContext {
  tenantId?: string;
  apiKeyId: string;
  apiKeyName: string;
}

export async function resolveTenantApiKey(token: string): Promise<TenantAuthContext> {
  if (!token) {
    throw new UnauthorizedError('Empty API key');
  }

  const keyHash = crypto.createHash('sha256').update(token).digest('hex');

  const db = getDbClient();
  const apiKey = await db.get<ApiKeyRow>(
    'SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1',
    [keyHash]
  );

  if (!apiKey) {
    throw new UnauthorizedError('Invalid API key');
  }

  // Check expiry
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    throw new UnauthorizedError('API key expired');
  }

  // Check tenant
  if (apiKey.tenant_id) {
    const tenant = await db.get<TenantRow>(
      'SELECT id, status FROM tenants WHERE id = ?',
      [apiKey.tenant_id]
    );

    if (!tenant || tenant.status !== 'active') {
      throw new UnauthorizedError('Tenant not active');
    }
  }

  // Update last_used_at asynchronously (don't block)
  setImmediate(() => {
    db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [
      new Date().toISOString(),
      apiKey.id,
    ]).catch(() => {
      // Non-critical
    });
  });

  return {
    tenantId: apiKey.tenant_id ?? undefined,
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
  };
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Public endpoints bypass auth
  if (req.path === '/health' || req.path.startsWith('/health')) {
    next();
    return;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(new UnauthorizedError('Missing Authorization header'));
    return;
  }

  const token = authHeader.slice(7).trim();

  resolveTenantApiKey(token)
    .then((auth) => {
      req.tenantId = auth.tenantId;
      req.apiKeyId = auth.apiKeyId;
      req.apiKeyName = auth.apiKeyName;
      next();
    })
    .catch((err) => {
      next(err);
    });
}
