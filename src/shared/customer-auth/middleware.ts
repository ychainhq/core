/// <reference path="../../types/express.d.ts" />
import { Request, Response, NextFunction } from 'express';
import { getDb } from '../../db/sqlite';
import { UnauthorizedError } from '../errors/index';
import { verifyCustomerToken } from './jwt.service';

export function customerAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(new UnauthorizedError('Missing Authorization header'));
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    next(new UnauthorizedError('Empty token'));
    return;
  }

  try {
    const payload = verifyCustomerToken(token);

    const db = getDb();

    // Validate tenant still active
    const tenant = db.prepare('SELECT status FROM tenants WHERE id = ?').get(payload.tid) as
      | { status: string }
      | undefined;
    if (!tenant || tenant.status !== 'active') {
      next(new UnauthorizedError('Tenant not active'));
      return;
    }

    // Validate customer still exists and is active
    const customer = db
      .prepare('SELECT status FROM customers WHERE id = ? AND tenant_id = ?')
      .get(payload.sub, payload.tid) as { status: string } | undefined;
    if (!customer) {
      next(new UnauthorizedError('Customer not found'));
      return;
    }
    if (customer.status !== 'active') {
      next(new UnauthorizedError(`Customer account is ${customer.status}`));
      return;
    }

    req.tenantId = payload.tid;
    req.customerId = payload.sub;
    next();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'invalid_token';
    if (msg === 'token_expired') {
      next(new UnauthorizedError('Token expired'));
    } else {
      next(new UnauthorizedError('Invalid token'));
    }
  }
}
