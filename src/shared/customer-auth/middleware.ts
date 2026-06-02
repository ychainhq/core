/// <reference path="../../types/express.d.ts" />
import { Request, Response, NextFunction } from 'express';
import { getDbClient } from '../../db/client';
import { UnauthorizedError } from '../errors/index';
import { verifyCustomerToken } from './jwt.service';

export interface CustomerAuthContext {
  tenantId: string;
  customerId: string;
}

export async function resolveCustomerSessionToken(token: string): Promise<CustomerAuthContext> {
  if (!token) {
    throw new UnauthorizedError('Empty token');
  }

  try {
    const payload = verifyCustomerToken(token);

    const db = getDbClient();

    // Validate tenant still active
    const tenant = await db.get<{ status: string }>(
      'SELECT status FROM tenants WHERE id = ?',
      [payload.tid]
    );
    if (!tenant || tenant.status !== 'active') {
      throw new UnauthorizedError('Tenant not active');
    }

    // Validate customer still exists and is active
    const customer = await db.get<{ status: string }>(
      'SELECT status FROM customers WHERE id = ? AND tenant_id = ?',
      [payload.sub, payload.tid]
    );
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

  resolveCustomerSessionToken(token)
    .then((auth) => {
      req.tenantId = auth.tenantId;
      req.customerId = auth.customerId;
      next();
    })
    .catch((err: unknown) => {
      next(err);
    });
}
