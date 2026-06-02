/**
 * Database abstraction layer.
 *
 * DbClient wraps both SQLite (better-sqlite3, dev/test) and PostgreSQL (pg, enterprise).
 * All methods are async regardless of underlying driver.
 *
 * SQL placeholders: always use `?` — the PgDbClient automatically converts to $1, $2, ...
 * Transaction pattern:
 *   await db.transaction(async (tx) => {
 *     await tx.run('INSERT INTO ...', [a, b]);
 *   });
 *
 * Factory: call getDbClient() to get the singleton for the current DB_TYPE.
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Pool, PoolClient } from 'pg';
import { config } from '../config/index';
import { logger } from '../shared/logging/index';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface DbRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DbClient {
  /** Returns all rows matching the query. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Returns first row or undefined. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Executes INSERT/UPDATE/DELETE. Returns affected row count. */
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;
  /** Executes multiple statements (DDL, migrations). No parameterisation. */
  exec(sql: string): Promise<void>;
  /** Wraps the callback in a transaction. Rolls back on throw. */
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  /** Returns true if connected to PostgreSQL. */
  readonly isPostgres: boolean;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

class SqliteDbClient implements DbClient {
  readonly isPostgres = false;
  constructor(private readonly db: Database.Database) {}

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const r = this.db.prepare(sql).run(...params);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    // better-sqlite3 is synchronous, so using BEGIN/COMMIT gives us consistent
    // semantics with PgDbClient. Node.js is single-threaded, so between BEGIN
    // and COMMIT no other code runs.
    // Use SAVEPOINT for nested transaction support (SQLite supports nested savepoints).
    const isNested = this.db.inTransaction;
    const savepointName = isNested ? `sp_${crypto.randomBytes(4).toString('hex')}` : null;
    if (isNested && savepointName) {
      this.db.prepare(`SAVEPOINT "${savepointName}"`).run();
    } else {
      this.db.prepare('BEGIN IMMEDIATE').run();
    }
    try {
      const result = await fn(this);
      if (isNested && savepointName) {
        this.db.prepare(`RELEASE SAVEPOINT "${savepointName}"`).run();
      } else {
        this.db.prepare('COMMIT').run();
      }
      return result;
    } catch (err) {
      try {
        if (isNested && savepointName) {
          this.db.prepare(`ROLLBACK TO SAVEPOINT "${savepointName}"`).run();
          this.db.prepare(`RELEASE SAVEPOINT "${savepointName}"`).run();
        } else {
          this.db.prepare('ROLLBACK').run();
        }
      } catch { /* ignore rollback error */ }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

function toPostgres(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

class PgTxClient implements DbClient {
  readonly isPostgres = true;
  constructor(private readonly client: PoolClient) {}

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { rows } = await this.client.query(toPostgres(sql), params);
    return rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const { rows } = await this.client.query(toPostgres(sql), params);
    return rows[0] as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const result = await this.client.query(toPostgres(sql), params);
    return { changes: result.rowCount ?? 0, lastInsertRowid: 0n };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    // Nested transaction — use SAVEPOINTs
    const sp = `sp_${Date.now()}`;
    await this.client.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }
}

class PgDbClient implements DbClient {
  readonly isPostgres = true;
  constructor(private readonly pool: Pool) {}

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { rows } = await this.pool.query(toPostgres(sql), params);
    return rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const { rows } = await this.pool.query(toPostgres(sql), params);
    return rows[0] as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const result = await this.pool.query(toPostgres(sql), params);
    return { changes: result.rowCount ?? 0, lastInsertRowid: 0n };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new PgTxClient(client);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — singleton per process
// ---------------------------------------------------------------------------

let clientInstance: DbClient | null = null;

export function getDbClient(): DbClient {
  if (clientInstance) return clientInstance;

  if (config.DB_TYPE === 'postgres') {
    if (!config.DATABASE_URL) {
      throw new Error('DATABASE_URL is required when DB_TYPE=postgres');
    }
    const pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      idleTimeoutMillis: config.DB_POOL_IDLE_TIMEOUT_MS,
    });
    pool.on('error', (err) => logger.error('pg pool error', { error: String(err) }));
    logger.info('PostgreSQL pool created', { max: config.DB_POOL_MAX });
    clientInstance = new PgDbClient(pool);
  } else {
    // SQLite: reuse the existing better-sqlite3 singleton from sqlite.ts
    // Import here to avoid circular deps; getDb() initialises if needed.
    const { getDb } = require('./sqlite') as typeof import('./sqlite');
    clientInstance = new SqliteDbClient(getDb());
  }

  return clientInstance;
}

export function resetDbClient(): void {
  clientInstance = null;
}

// ---------------------------------------------------------------------------
// FOR UPDATE SKIP LOCKED helper (PostgreSQL only)
// Useful for worker job queues: atomically claim a batch of unprocessed rows.
// ---------------------------------------------------------------------------

export async function claimRows<T>(
  db: DbClient,
  sql: string,
  params: unknown[],
  updateSql: string,
  updateParams: unknown[],
): Promise<T[]> {
  if (!db.isPostgres) {
    // SQLite fallback: plain SELECT + UPDATE (single active engine, no concurrency)
    const rows = await db.all<T>(sql, params);
    if (rows.length > 0) {
      await db.run(updateSql, updateParams);
    }
    return rows;
  }
  // PostgreSQL: SELECT ... FOR UPDATE SKIP LOCKED atomically
  return db.transaction(async (tx) => {
    const rows = await tx.all<T>(sql + ' FOR UPDATE SKIP LOCKED', params);
    if (rows.length > 0) {
      await tx.run(updateSql, updateParams);
    }
    return rows;
  });
}
