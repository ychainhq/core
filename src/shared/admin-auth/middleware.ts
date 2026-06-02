import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { getDbClient } from '../../db/client';
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

export async function resolveAdminKey(adminKey: string | undefined): Promise<AdminAuthContext> {
  if (!adminKey) {
    throw new UnauthorizedError('Admin key required');
  }

  const keyHash = crypto.createHash('sha256').update(adminKey).digest('hex');

  const db = getDbClient();
  const key = await db.get<AdminKeyRow>(
    'SELECT * FROM admin_keys WHERE key_hash = ? AND is_active = 1',
    [keyHash]
  );

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

  resolveAdminKey(adminKey)
    .then((auth) => {
      req.adminKeyName = auth.adminKeyName;
      next();
    })
    .catch((err) => {
      next(err);
    });
}
