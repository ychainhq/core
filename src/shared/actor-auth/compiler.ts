import { AccessFilter, SqlFragment } from './types';

/**
 * Compiles an AccessFilter to a SQLite WHERE fragment.
 * The returned sql always starts with "AND " so it can be safely appended
 * to a "WHERE 1=1" base query.
 *
 * Every compiled fragment embeds tenant_id — the caller does NOT need to
 * add a separate tenant filter.
 */
export function compileSqliteFilter(filter: AccessFilter, tableAlias: string): SqlFragment {
  const a = tableAlias;

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
            OR (${a}.access_user_ids IS NOT NULL AND EXISTS (
              SELECT 1 FROM json_each(${a}.access_user_ids) WHERE value = ?
            ))
          )`,
          params: [filter.tenantId, filter.actorId, filter.actorId],
        };
      }

      const ph = teams.map(() => '?').join(',');
      return {
        sql: `AND ${a}.tenant_id = ? AND (
          ${a}.owner_user_id = ?
          OR ${a}.owner_team_id IN (${ph})
          OR (${a}.access_team_ids IS NOT NULL AND EXISTS (
            SELECT 1 FROM json_each(${a}.access_team_ids) WHERE value IN (${ph})
          ))
          OR (${a}.access_user_ids IS NOT NULL AND EXISTS (
            SELECT 1 FROM json_each(${a}.access_user_ids) WHERE value = ?
          ))
        )`,
        // teams repeated twice: once for owner_team_id IN, once for access_team_ids
        params: [filter.tenantId, filter.actorId, ...teams, ...teams, filter.actorId],
      };
    }

    case 'assigned':
      return {
        sql: `AND ${a}.tenant_id = ? AND (
          ${a}.owner_user_id = ?
          OR (${a}.access_user_ids IS NOT NULL AND EXISTS (
            SELECT 1 FROM json_each(${a}.access_user_ids) WHERE value = ?
          ))
        )`,
        params: [filter.tenantId, filter.actorId, filter.actorId],
      };
  }
}
