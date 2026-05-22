export type AccessLevel = 'all' | 'team' | 'assigned' | 'none';

export interface Permission {
  entity: string;
  action: 'read' | 'write';
  level: Exclude<AccessLevel, 'none'>;
}

export interface ActorContext {
  tenantId: string;
  actorId: string;
  roles: string[];
  permissions: Permission[];
  /** Pre-expanded list of allowed teams — sent by the tenant directly in the token. */
  teams: string[];
  tokenMeta: {
    issuedAt: number;
    expiresAt: number;
    jti?: string;
  };
}

export interface ResolvedAccess {
  level: AccessLevel;
}

/**
 * Data-source-agnostic representation of an access filter.
 * Compiled to SQL/search-engine fragments by DataSourcePolicyCompiler.
 */
export type AccessFilter =
  | { type: 'deny' }
  | { type: 'all'; tenantId: string }
  | { type: 'team'; tenantId: string; allowedTeams: string[]; actorId: string }
  | { type: 'assigned'; tenantId: string; actorId: string };

/** A compiled SQL fragment ready to be appended with AND. */
export interface SqlFragment {
  /** SQL snippet starting with "AND ...". */
  sql: string;
  params: unknown[];
}

export interface SortField {
  /** Physical column expression (with table alias), e.g. "c.updated_at". */
  physical: string;
  type: 'text' | 'timestamp' | 'enum' | 'number';
}

export interface SortPolicy {
  allowed: Record<string, SortField>;
  default: { field: string; direction: 'asc' | 'desc' };
  tieBreaker: { physical: string; direction: 'asc' | 'desc' };
}

export interface NormalizedSort {
  primary: { physical: string; direction: 'asc' | 'desc' };
  tieBreaker: { physical: string; direction: 'asc' | 'desc' };
}

export interface EntityDefinition {
  name: string;
  table: string;
  alias: string;
  sortPolicy: SortPolicy;
}

export interface DecodedCursor {
  /** Last values for primary sort field and tie-breaker field. */
  lastValues: Record<string, unknown>;
  /** SHA256 of the sort string so cursor is invalidated on sort change. */
  sortHash: string;
  tenantId: string;
  actorId: string | null;
  expiresAt: number;
}
