import { ActorContext, Permission, AccessLevel, ResolvedAccess } from './types';
import { RawActorClaims } from './verifier';

function parsePermission(str: string): Permission | null {
  const parts = str.split(':');
  if (parts.length !== 3) return null;
  const [entity, action, level] = parts;
  if (!entity || !action || !level) return null;
  if (action !== 'read' && action !== 'write') return null;
  if (level !== 'all' && level !== 'team' && level !== 'assigned') return null;
  return {
    entity,
    action: action as 'read' | 'write',
    level: level as Exclude<AccessLevel, 'none'>,
  };
}

export function resolveActorContext(claims: RawActorClaims): ActorContext {
  const permissions: Permission[] = [];
  for (const pStr of claims.permissions ?? []) {
    const p = parsePermission(pStr);
    if (p) permissions.push(p);
  }

  return {
    tenantId: claims.tenant_id,
    actorId: claims.sub,
    roles: claims.roles ?? [],
    permissions,
    teams: claims.teams ?? [],
    tokenMeta: {
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      jti: claims.jti,
    },
  };
}

/**
 * Returns the effective access level for a given entity + action.
 * Priority: all > team > assigned > none.
 */
export function resolvePermission(
  ctx: ActorContext,
  entity: string,
  action: 'read' | 'write'
): ResolvedAccess {
  const matching = ctx.permissions.filter(
    (p) => p.entity === entity && p.action === action
  );

  if (matching.some((p) => p.level === 'all')) return { level: 'all' };
  if (matching.some((p) => p.level === 'team')) return { level: 'team' };
  if (matching.some((p) => p.level === 'assigned')) return { level: 'assigned' };

  return { level: 'none' };
}
