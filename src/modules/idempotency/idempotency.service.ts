import { getDb } from '../../db/sqlite';

interface IdempotencyRow {
  tenant_id: string;
  key: string;
  operation: string;
  result: string;
  status_code: number;
  created_at: string;
  expires_at: string;
}

export interface IdempotencyResult {
  result: unknown;
  statusCode: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class IdempotencyService {
  /**
   * Look up an existing idempotency key result (tenant-scoped).
   * Returns null if not found or expired.
   */
  get(tenantId: string, key: string, operation: string): IdempotencyResult | null {
    const db = getDb();
    const row = db
      .prepare(
        'SELECT * FROM idempotency_keys WHERE tenant_id = ? AND key = ? AND operation = ? AND expires_at > ?'
      )
      .get(tenantId, key, operation, new Date().toISOString()) as IdempotencyRow | undefined;

    if (!row) return null;

    return {
      result: JSON.parse(row.result),
      statusCode: row.status_code,
    };
  }

  /**
   * Save an idempotency key result (tenant-scoped).
   */
  save(tenantId: string, key: string, operation: string, result: unknown, statusCode: number): void {
    const db = getDb();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MS);

    db.prepare(`
      INSERT OR REPLACE INTO idempotency_keys (tenant_id, key, operation, result, status_code, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      key,
      operation,
      JSON.stringify(result),
      statusCode,
      now.toISOString(),
      expiresAt.toISOString()
    );
  }

  /**
   * Clean up expired idempotency keys.
   */
  cleanup(): number {
    const db = getDb();
    const result = db
      .prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?')
      .run(new Date().toISOString());
    return result.changes;
  }
}

export const idempotencyService = new IdempotencyService();

/**
 * Schedule periodic cleanup every hour.
 */
setInterval(() => {
  const cleaned = idempotencyService.cleanup();
  if (cleaned > 0) {
    // logger import would create circular dep — use console
    process.stdout.write(JSON.stringify({ level: 'debug', message: 'Cleaned idempotency keys', cleaned }) + '\n');
  }
}, 60 * 60 * 1000);
