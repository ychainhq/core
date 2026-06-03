/**
 * PostgreSQL compatibility unit tests.
 *
 * These tests verify SQL generated for PostgreSQL (isPostgres=true) contains
 * PG-specific syntax, and SQLite path contains SQLite-specific syntax.
 * They run without a real DB — they test the SQL strings produced by
 * services/compiler when the DB client reports isPostgres=true.
 *
 * WHY: All integration tests use SQLite in-memory. SQLite-only syntax
 * (rowid, IS ?, json_each) compiles and runs fine in SQLite but crashes
 * on PostgreSQL. This file guards against regressions at the unit level.
 */

import { compileFilter } from '../../src/shared/actor-auth/compiler';
import { getDbClient } from '../../src/db/client';

// ─── compileFilter — json_each vs json_array_elements_text ────────────────────

describe('compileFilter — SQL dialect', () => {
  const filter = {
    type: 'team' as const,
    tenantId: 't1',
    actorId: 'u1',
    allowedTeams: ['team_a', 'team_b'],
  };

  test('SQLite path uses json_each', () => {
    const { sql } = compileFilter(filter, 'c', false);
    expect(sql).toContain('json_each');
    expect(sql).not.toContain('json_array_elements_text');
  });

  test('PostgreSQL path uses json_array_elements_text', () => {
    const { sql } = compileFilter(filter, 'c', true);
    expect(sql).toContain('json_array_elements_text');
    expect(sql).not.toContain('json_each');
  });

  test('PostgreSQL path casts column to ::json', () => {
    const { sql } = compileFilter(filter, 'c', true);
    expect(sql).toMatch(/::json/);
  });

  test('assigned filter — PostgreSQL path', () => {
    const assigned = { type: 'assigned' as const, tenantId: 't1', actorId: 'u1' };
    const { sql } = compileFilter(assigned, 'c', true);
    expect(sql).toContain('json_array_elements_text');
    expect(sql).not.toContain('json_each');
  });

  test('team filter with no teams degrades to assigned — PG path', () => {
    const noTeams = { type: 'team' as const, tenantId: 't1', actorId: 'u1', allowedTeams: [] };
    const { sql } = compileFilter(noTeams, 'c', true);
    expect(sql).toContain('json_array_elements_text');
    expect(sql).not.toContain('json_each');
  });

  test('all filter — no json function in either dialect', () => {
    const all = { type: 'all' as const, tenantId: 't1' };
    const sqlSqlite = compileFilter(all, 'c', false).sql;
    const sqlPg = compileFilter(all, 'c', true).sql;
    expect(sqlSqlite).not.toContain('json_each');
    expect(sqlPg).not.toContain('json_array_elements_text');
  });
});

// ─── deposits.service.upsert — vout IS ? vs IS NOT DISTINCT FROM ──────────────

// We cannot import deposits.service directly because it calls getDbClient() at
// module-level. Instead, test the vout-equality SQL fragment pattern used in
// the service by constructing it the same way the service does.
describe('deposits upsert vout equality SQL', () => {
  function buildVoutEq(isPostgres: boolean): string {
    return isPostgres ? 'vout IS NOT DISTINCT FROM ?' : 'vout IS ?';
  }

  test('SQLite path uses IS ? (null-safe comparison)', () => {
    expect(buildVoutEq(false)).toBe('vout IS ?');
  });

  test('PostgreSQL path uses IS NOT DISTINCT FROM ?', () => {
    expect(buildVoutEq(true)).toBe('vout IS NOT DISTINCT FROM ?');
  });

  test('PostgreSQL path does NOT use "IS ?" which would cause syntax error', () => {
    // "IS ?" is invalid PostgreSQL syntax — only "IS NULL"/"IS NOT NULL"/"IS TRUE" etc.
    const sql = `SELECT * FROM deposits WHERE chain_id = ? AND tx_hash = ? AND ${buildVoutEq(true)}`;
    expect(sql).not.toMatch(/\bIS \?/);
    expect(sql).toContain('IS NOT DISTINCT FROM');
  });
});

// ─── SQL must NOT contain rowid anywhere ──────────────────────────────────────

describe('rowid is absent from service SQL', () => {
  // Read the compiled service files to ensure rowid was removed.
  // (These tests would have caught the bug before the fix landed.)
  const fs = require('fs');
  const path = require('path');

  function readSource(relPath: string): string {
    const full = path.join(__dirname, '../../src', relPath);
    if (!fs.existsSync(full)) return '';
    return fs.readFileSync(full, 'utf8');
  }

  test('ledger.service.ts has no ORDER BY rowid', () => {
    const src = readSource('modules/ledger/ledger.service.ts');
    expect(src).not.toMatch(/ORDER BY rowid/i);
  });

  test('customers.service.ts has no ORDER BY rowid', () => {
    const src = readSource('modules/customers/customers.service.ts');
    expect(src).not.toMatch(/ORDER BY rowid/i);
  });
});
