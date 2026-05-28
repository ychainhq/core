import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { getDb } from '../../db/sqlite';
import { UnauthorizedError } from '../errors/index';

interface AdminKeyRow {
  id: string;
  key_hash: string;
  name: string;
  is_active: number;
}

export interface AdminAuthContext {
  adminKeyId: string;
  adminKeyName: string;
}

export function resolveAdminKey(adminKey: string | undefined): AdminAuthContext {
  if (!adminKey) {
    throw new UnauthorizedError('Admin key required');
  }

  const keyHash = crypto.createHash('sha256').update(adminKey).digest('hex');

  const db = getDb();
  const key = db
    .prepare('SELECT * FROM admin_keys WHERE key_hash = ? AND is_active = 1')
    .get(keyHash) as AdminKeyRow | undefined;

  if (!key) {
    throw new UnauthorizedError('Invalid admin key');
  }

  return {
    adminKeyId: key.id,
    adminKeyName: key.name,
  };
}

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Try X-Admin-Key header first, then Authorization header
  const adminKey =
    (req.headers['x-admin-key'] as string | undefined) ??
    (req.headers['authorization']?.startsWith('Bearer aak_')
      ? req.headers['authorization'].slice(7)
      : undefined);

  try {
    const auth = resolveAdminKey(adminKey);
    req.adminKeyName = auth.adminKeyName;
    next();
  } catch (err) {
    next(err);
  }
}
