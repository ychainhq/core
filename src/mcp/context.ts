import { Request } from 'express';
import { UnauthorizedError, ValidationError } from '../shared/errors/index';
import { resolveTenantApiKey } from '../shared/auth/middleware';
import { resolveCustomerSessionToken } from '../shared/customer-auth/middleware';
import { resolveAdminKey } from '../shared/admin-auth/middleware';
import { config } from '../config/index';

export type McpAuthContext =
  | { kind: 'tenant'; tenantId: string; apiKeyId: string; apiKeyName: string }
  | { kind: 'customer'; tenantId: string; customerId: string }
  | { kind: 'admin'; adminKeyId: string; adminKeyName: string };

export type McpServerKind = 'tenant' | 'customer' | 'admin';

export function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.origin;
  if (!origin) return;

  const allowed = config.MCP_ALLOWED_ORIGINS.split(',').map((v) => v.trim()).filter(Boolean);
  const originUrl = new URL(origin);
  const originBase = `${originUrl.protocol}//${originUrl.hostname}`;
  const allowedExact = allowed.includes(origin);
  const allowedBase = allowed.includes(originBase);

  if (!allowedExact && !allowedBase) {
    throw new ValidationError(`Origin '${origin}' is not allowed for MCP`);
  }
}

export function resolveMcpContext(req: Request, kind: McpServerKind): McpAuthContext {
  if (kind === 'admin') {
    if (!config.MCP_ADMIN_ENABLED) {
      throw new UnauthorizedError('Admin MCP is disabled');
    }
    const adminKey =
      (req.headers['x-admin-key'] as string | undefined) ??
      (req.headers.authorization?.startsWith('Bearer aak_') ? req.headers.authorization.slice(7) : undefined);
    return { kind: 'admin', ...resolveAdminKey(adminKey) };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing Authorization header');
  }

  const token = authHeader.slice(7).trim();
  if (kind === 'customer') {
    return { kind: 'customer', ...resolveCustomerSessionToken(token) };
  }

  const auth = resolveTenantApiKey(token);
  if (!auth.tenantId) {
    throw new UnauthorizedError('Tenant API key required');
  }
  return { kind: 'tenant', tenantId: auth.tenantId, apiKeyId: auth.apiKeyId, apiKeyName: auth.apiKeyName };
}

export function requireTenant(ctx: McpAuthContext): Extract<McpAuthContext, { kind: 'tenant' }> {
  if (ctx.kind !== 'tenant') throw new UnauthorizedError('Tenant MCP context required');
  return ctx;
}

export function requireCustomer(ctx: McpAuthContext): Extract<McpAuthContext, { kind: 'customer' }> {
  if (ctx.kind !== 'customer') throw new UnauthorizedError('Customer MCP context required');
  return ctx;
}

export function requireAdmin(ctx: McpAuthContext): Extract<McpAuthContext, { kind: 'admin' }> {
  if (ctx.kind !== 'admin') throw new UnauthorizedError('Admin MCP context required');
  return ctx;
}

