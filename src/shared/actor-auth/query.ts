import { AccessFilter, SqlFragment } from './types';
import { compileSqliteFilter } from './compiler';

/**
 * Thin wrapper that enforces access filter presence in every data-source query.
 * Construct with SecuredQuery.for(filter, tableAlias), then:
 *  - Check isDenied before executing
 *  - Append fragment.sql + spread fragment.params into your query
 *
 * Example:
 *   const sq = SecuredQuery.for(accessFilter, 'c');
 *   if (sq.isDenied) return { data: [], nextCursor: null };
 *   db.prepare(`SELECT * FROM customers c WHERE 1=1 ${sq.fragment.sql} LIMIT ?`)
 *     .all(...sq.fragment.params, limit);
 */
export class SecuredQuery {
  private readonly _fragment: SqlFragment;
  private readonly _isDenied: boolean;

  private constructor(filter: AccessFilter, tableAlias: string) {
    this._isDenied = filter.type === 'deny';
    this._fragment = compileSqliteFilter(filter, tableAlias);
  }

  static for(filter: AccessFilter, tableAlias: string): SecuredQuery {
    return new SecuredQuery(filter, tableAlias);
  }

  /** Compiled SQL fragment — always starts with "AND ...". */
  get fragment(): SqlFragment {
    return this._fragment;
  }

  /** True when the filter is 'deny' — caller should return empty result immediately. */
  get isDenied(): boolean {
    return this._isDenied;
  }
}
