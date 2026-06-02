import { AccessFilter, SqlFragment } from './types';

/**
 * Compiles an AccessFilter to a WHERE fragment (always starts with "AND ").
 * Supports both SQLite (json_each) and PostgreSQL (json_array_elements_text).
 *
 * Every compiled fragment embeds tenant_id — the caller does NOT need to
 * add a separate tenant filter.
 */
export function compileFilter(filter: AccessFilter, tableAlias: string, isPostgres: boolean): SqlFragment {
  const a = tableAlias;

  // JSON array membership check — syntax differs between SQLite and PostgreSQL
  const jsonHas = (col: string, ph: string) => isPostgres
    ? `EXISTS (SELECT 1 FROM json_array_elements_text(${col}::json) AS jv WHERE jv = ${ph})`
    : `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ${ph})`;

  const jsonHasAny = (col: string, phs: string) => isPostgres
    ? `EXISTS (SELECT 1 FROM json_array_elements_text(${col}::json) AS jv WHERE jv IN (${phs}))`
    : `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${phs}))`;

  switch (filter.type) {
    case 'deny':
      return { sql: 'AND 1=0', params: [] };

    case 'all':
      return {
        sql: `AND ${a}.tenant_id = ?`,
        params: [filter.tenantId],
      };

    case 'team': {
      const teams = filter.allowedTeams;

      // No teams in token — degrade to assigned-only (actor sees own records)
      if (teams.length === 0) {
        return {
          sql: `AND ${a}.tenant_id = ? AND (
            ${a}.owner_user_id = ?
            OR (${a}.access_user_ids IS NOT NULL AND ${jsonHas(`${a}.access_user_ids`, '?')})
          )`,
          params: [filter.tenantId, filter.actorId, filter.actorId],
        };
      }

      const ph = teams.map(() => '?').join(',');
      return {
        sql: `AND ${a}.tenant_id = ? AND (
          ${a}.owner_user_id = ?
          OR ${a}.owner_team_id IN (${ph})
          OR (${a}.access_team_ids IS NOT NULL AND ${jsonHasAny(`${a}.access_team_ids`, ph)})
          OR (${a}.access_user_ids IS NOT NULL AND ${jsonHas(`${a}.access_user_ids`, '?')})
        )`,
        // teams repeated twice: once for owner_team_id IN, once for access_team_ids json check
        params: [filter.tenantId, filter.actorId, ...teams, ...teams, filter.actorId],
      };
    }

    case 'assigned':
      return {
        sql: `AND ${a}.tenant_id = ? AND (
          ${a}.owner_user_id = ?
          OR (${a}.access_user_ids IS NOT NULL AND ${jsonHas(`${a}.access_user_ids`, '?')})
        )`,
        params: [filter.tenantId, filter.actorId, filter.actorId],
      };
  }
}

/** @deprecated Use compileFilter(filter, alias, isPostgres) */
export function compileSqliteFilter(filter: AccessFilter, tableAlias: string): SqlFragment {
  return compileFilter(filter, tableAlias, false);
}
