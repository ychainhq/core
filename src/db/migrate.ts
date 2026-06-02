import fs from 'fs';
import path from 'path';
import { getDb } from './sqlite';
import { config } from '../config/index';
import { logger } from '../shared/logging/index';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface MigrationRow {
  version: string;
  applied_at: string;
}

export async function runMigrations(): Promise<void> {
  if (config.DB_TYPE === 'postgres') {
    await runMigrationsPostgres();
  } else {
    runMigrationsSqlite();
  }
}

// ---------------------------------------------------------------------------
// SQLite migration runner (synchronous, used for dev/test)
// ---------------------------------------------------------------------------

function runMigrationsSqlite(): void {
  const db = getDb();
  logger.info('Running SQLite migrations...');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = db.prepare('SELECT version FROM schema_migrations').all() as MigrationRow[];
  const appliedVersions = new Set(applied.map((r) => r.version));

  let appliedCount = 0;

  for (const file of migrationFiles) {
    const version = file.replace('.sql', '');
    if (appliedVersions.has(version)) {
      logger.debug('Migration already applied', { version });
      continue;
    }

    logger.info('Applying migration', { version });
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString()
      );
      logger.info('Migration applied', { version });
      appliedCount++;
    } catch (err) {
      logger.error('Migration failed', { version, error: String(err) });
      throw err;
    }
  }

  if (appliedCount === 0) {
    logger.info('No new migrations to apply');
  } else {
    logger.info(`Applied ${appliedCount} migration(s)`);
  }
}

// ---------------------------------------------------------------------------
// SQLite → PostgreSQL SQL translation
// Migrations are written in SQLite dialect. This function translates the
// SQLite-specific constructs that differ from PostgreSQL.
// ---------------------------------------------------------------------------

/**
 * Translate SQLite-specific SQL constructs to PostgreSQL equivalents.
 * Migrations are authored in SQLite dialect (used for dev/test).
 * When running against PostgreSQL, these constructs must be translated.
 *
 * Conversions applied:
 *   INSERT OR IGNORE INTO <t> ... ;  →  INSERT INTO <t> ... ON CONFLICT DO NOTHING;
 *   datetime('now')                  →  NOW()
 *   json_object(k,v,...)             →  json_build_object(k,v,...)
 */
function translateSqliteToPostgres(sql: string): string {
  let result = sql;

  // 1. datetime('now') → NOW()
  result = result.replace(/datetime\('now'\)/gi, 'NOW()');

  // 2. json_object(...) → json_build_object(...)
  //    SQLite: json_object('k1', v1, 'k2', v2)
  //    PostgreSQL: json_build_object('k1', v1, 'k2', v2)
  //    Both functions accept alternating key/value pairs — only name differs.
  result = result.replace(/\bjson_object\s*\(/gi, 'json_build_object(');

  // 3. INSERT OR IGNORE INTO <table> ...;
  //    Captures everything from INSERT OR IGNORE through the closing semicolon
  //    and injects ON CONFLICT DO NOTHING before it.
  result = result.replace(
    /INSERT\s+OR\s+IGNORE\s+(INTO\s[\s\S]*?);/gi,
    'INSERT $1\n  ON CONFLICT DO NOTHING;'
  );

  return result;
}

// ---------------------------------------------------------------------------
// PostgreSQL migration runner (async)
// ---------------------------------------------------------------------------

async function runMigrationsPostgres(): Promise<void> {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL required for DB_TYPE=postgres');

  // Import pg here to avoid loading it when running SQLite
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: config.DATABASE_URL });

  try {
    logger.info('Running PostgreSQL migrations...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const migrationFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows: applied } = await pool.query('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(applied.map((r: MigrationRow) => r.version));

    let appliedCount = 0;

    for (const file of migrationFiles) {
      const version = file.replace('.sql', '');
      if (appliedVersions.has(version)) {
        logger.debug('Migration already applied', { version });
        continue;
      }

      logger.info('Applying migration', { version });
      const rawSql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      // Translate SQLite-specific syntax to PostgreSQL equivalents
      const sql = translateSqliteToPostgres(rawSql);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
          [version, new Date().toISOString()]
        );
        await client.query('COMMIT');
        logger.info('Migration applied', { version });
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Migration failed', { version, error: String(err) });
        throw err;
      } finally {
        client.release();
      }
    }

    if (appliedCount === 0) {
      logger.info('No new migrations to apply');
    } else {
      logger.info(`Applied ${appliedCount} migration(s)`);
    }
  } finally {
    await pool.end();
  }
}

// Run if executed directly
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
