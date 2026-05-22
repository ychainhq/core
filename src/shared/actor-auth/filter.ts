import { ActorContext, AccessFilter, ResolvedAccess } from './types';

/**
 * Builds an abstract AccessFilter from a resolved permission level.
 * The filter is data-source-agnostic; compile it with DataSourcePolicyCompiler.
 */
export function buildAccessFilter(
  resolved: ResolvedAccess,
  ctx: ActorContext
): AccessFilter {
  switch (resolved.level) {
    case 'all':
      return { type: 'all', tenantId: ctx.tenantId };

    case 'team':
      return {
        type: 'team',
        tenantId: ctx.tenantId,
        allowedTeams: ctx.teams,
        actorId: ctx.actorId,
      };

    case 'assigned':
      return { type: 'assigned', tenantId: ctx.tenantId, actorId: ctx.actorId };

    case 'none':
      return { type: 'deny' };
  }
}

/**
 * Full-tenant access filter used when no X-Actor-Token is present.
 * The tenant is trusted to control whether it sends an actor token.
 */
export function adminAllFilter(tenantId: string): AccessFilter {
  return { type: 'all', tenantId };
}
