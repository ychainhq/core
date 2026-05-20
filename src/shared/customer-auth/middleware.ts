/// <reference path="../../types/express.d.ts" />
import { Request, Response, NextFunction } from 'express';
import { getDb } from '../../db/sqlite';
import { UnauthorizedError } from '../errors/index';
import { verifyCustomerToken } from './jwt.service';

export interface CustomerAuthContext {
  tenantId: string;
  customerId: string;
}

export function resolveCustomerSessionToken(token: string): CustomerAuthContext {
  if (!token) {
    throw new UnauthorizedError('Empty token');
  }

  try {
    const payload = verifyCustomerToken(token);

    const db = getDb();

    // Validate tenant still active
    const tenant = db.prepare('SELECT status FROM tenants WHERE id = ?').get(payload.tid) as
      | { status: string }
      | undefined;
    if (!tenant || tenant.status !== 'active') {
      throw new UnauthorizedError('Tenant not active');
    }

    // Validate customer still exists and is active
    const customer = db
      .prepare('SELECT status FROM customers WHERE id = ? AND tenant_id = ?')
      .get(payload.sub, payload.tid) as { status: string } | undefined;
    if (!customer) {
      throw new UnauthorizedError('Customer not found');
    }
    if (customer.status !== 'active') {
      throw new UnauthorizedError(`Customer account is ${customer.status}`);
    }

    return {
      tenantId: payload.tid,
      customerId: payload.sub,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'invalid_token';
    if (msg === 'token_expired') {
      throw new UnauthorizedError('Token expired');
    }
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError('Invalid token');
  }
}

export function customerAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(new UnauthorizedError('Missing Authorization header'));
    return;
  }

  const token = authHeader.slice(7).trim();

  try {
    const auth = resolveCustomerSessionToken(token);
    req.tenantId = auth.tenantId;
    req.customerId = auth.customerId;
    next();
  } catch (err: unknown) {
    next(err);
  }
}
