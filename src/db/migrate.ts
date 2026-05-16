import fs from 'fs';
import path from 'path';
import { getDb } from './sqlite';
import { logger } from '../shared/logging/index';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface MigrationRow {
  version: string;
  applied_at: string;
}

export function runMigrations(): void {
  const db = getDb();
  logger.info('Running database migrations...');

  // Ensure schema_migrations table exists first
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

  const applied = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as MigrationRow[];
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

// Run if executed directly
if (require.main === module) {
  try {
    runMigrations();
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}
