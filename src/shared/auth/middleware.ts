/// <reference path="../../types/express.d.ts" />
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { getDb } from '../../db/sqlite';
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
  if (!token) {
    next(new UnauthorizedError('Empty API key'));
    return;
  }

  const keyHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const db = getDb();
    const apiKey = db
      .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1')
      .get(keyHash) as ApiKeyRow | undefined;

    if (!apiKey) {
      next(new UnauthorizedError('Invalid API key'));
      return;
    }

    // Check expiry
    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      next(new UnauthorizedError('API key expired'));
      return;
    }

    // Check tenant
    if (apiKey.tenant_id) {
      const tenant = db
        .prepare('SELECT id, status FROM tenants WHERE id = ?')
        .get(apiKey.tenant_id) as TenantRow | undefined;

      if (!tenant || tenant.status !== 'active') {
        next(new UnauthorizedError('Tenant not active'));
        return;
      }
    }

    // Update last_used_at asynchronously (don't block)
    setImmediate(() => {
      try {
        db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(
          new Date().toISOString(),
          apiKey.id
        );
      } catch {
        // Non-critical
      }
    });

    req.tenantId = apiKey.tenant_id ?? undefined;
    req.apiKeyId = apiKey.id;
    req.apiKeyName = apiKey.name;

    next();
  } catch (err) {
    next(err);
  }
}
