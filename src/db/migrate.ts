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
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

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
