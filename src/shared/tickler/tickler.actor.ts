import { Request } from 'express';

/**
 * Resolves a human-readable actor login string from the request context.
 * Used as actor_login in tickler records.
 *
 * Priority:
 *   1. X-Actor-Token JWT sub → "actor:{sub}"
 *   2. Admin key name       → "admin:{name}"
 *   3. Tenant API key name  → "key:{name}"
 *   4. Customer JWT sub     → "customer:{customerId}"
 *   5. null
 */
export function resolveActorLogin(req: Request): string | null {
  if ((req as any).actorContext?.actorId) {
    return `actor:${(req as any).actorContext.actorId}`;
  }
  if ((req as any).adminKeyName) {
    return `admin:${(req as any).adminKeyName}`;
  }
  if ((req as any).apiKeyName) {
    return `key:${(req as any).apiKeyName}`;
  }
  if ((req as any).customerId) {
    return `customer:${(req as any).customerId}`;
  }
  return null;
}
