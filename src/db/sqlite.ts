import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config/index';
import { logger } from '../shared/logging/index';

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const isMemory = config.SQLITE_DB_PATH === ':memory:';
  const dbPath = isMemory ? ':memory:' : path.resolve(config.SQLITE_DB_PATH);

  if (!isMemory) {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  logger.info('Opening SQLite database', { path: dbPath });

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Enable foreign key constraints
  db.pragma('foreign_keys = ON');
  // Improve performance
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = 8000');
  db.pragma('temp_store = MEMORY');

  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info('SQLite database closed');
  }
}

// Export singleton for convenience
export const db = {
  get(): Database.Database {
    return getDb();
  },
};
