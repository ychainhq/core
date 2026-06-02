import { getDbClient } from '../../db/client';

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
  async get(tenantId: string, key: string, operation: string): Promise<IdempotencyResult | null> {
    const db = getDbClient();
    const row = await db.get<IdempotencyRow>(
      'SELECT * FROM idempotency_keys WHERE tenant_id = ? AND key = ? AND operation = ? AND expires_at > ?',
      [tenantId, key, operation, new Date().toISOString()]
    );

    if (!row) return null;

    return {
      result: JSON.parse(row.result),
      statusCode: row.status_code,
    };
  }

  /**
   * Save an idempotency key result (tenant-scoped).
   */
  async save(tenantId: string, key: string, operation: string, result: unknown, statusCode: number): Promise<void> {
    const db = getDbClient();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MS);

    await db.run(
      `INSERT INTO idempotency_keys (tenant_id, key, operation, result, status_code, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, key, operation) DO UPDATE SET
        result = excluded.result,
        status_code = excluded.status_code,
        expires_at = excluded.expires_at`,
      [
        tenantId,
        key,
        operation,
        JSON.stringify(result),
        statusCode,
        now.toISOString(),
        expiresAt.toISOString(),
      ]
    );
  }

  /**
   * Clean up expired idempotency keys.
   */
  async cleanup(): Promise<number> {
    const db = getDbClient();
    const result = await db.run(
      'DELETE FROM idempotency_keys WHERE expires_at <= ?',
      [new Date().toISOString()]
    );
    return result.changes;
  }
}

export const idempotencyService = new IdempotencyService();

/**
 * Schedule periodic cleanup every hour.
 */
setInterval(async () => {
  const cleaned = await idempotencyService.cleanup();
  if (cleaned > 0) {
    // logger import would create circular dep — use console
    process.stdout.write(JSON.stringify({ level: 'debug', message: 'Cleaned idempotency keys', cleaned }) + '\n');
  }
}, 60 * 60 * 1000);
