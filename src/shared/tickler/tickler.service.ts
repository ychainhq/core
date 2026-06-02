import crypto from 'crypto';
import { getDbClient } from '../../db/client';
import { logger } from '../logging/index';
import { TicklerPayload, TicklerRecord } from './tickler.types';

function serializeValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function mapRow(row: any): TicklerRecord {
  return {
    ...row,
    prev_value: row.prev_value ? JSON.parse(row.prev_value) : null,
    new_value: row.new_value ? JSON.parse(row.new_value) : null,
  };
}

export const ticklerService = {
  /**
   * Zapisuje tickler. Best-effort — nigdy nie rzuca wyjątku.
   * Błędy zapisu do DB są logowane jako warn, nie przerywają operacji biznesowej.
   */
  record(payload: TicklerPayload): void {
    const db = getDbClient();
    const id = `tck_${crypto.randomBytes(8).toString('hex')}`;
    db.run(`
      INSERT INTO ticklers
        (id, occurred_at, tenant_id, category, subcategory, entity_id, actor_login,
         field1, field2, field3, field4, field5, prev_value, new_value)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      Date.now(),
      payload.tenantId ?? null,
      payload.category,
      payload.subcategory,
      payload.entityId ?? null,
      payload.actorLogin ?? null,
      payload.field1 ?? null,
      payload.field2 ?? null,
      payload.field3 ?? null,
      payload.field4 ?? null,
      payload.field5 ?? null,
      serializeValue(payload.prevValue),
      serializeValue(payload.newValue),
    ]).catch((err: unknown) => {
      logger.warn('tickler write failed', { err: String(err), category: payload.category, subcategory: payload.subcategory });
    });
  },

  async list(opts: {
    tenantId?: string | null;
    includeGlobal?: boolean;
    category?: string;
    subcategory?: string;
    entityId?: string;
    actorLogin?: string;
    from?: number;
    to?: number;
    limit?: number;
    cursor?: string | null;
  }): Promise<{ data: TicklerRecord[]; nextCursor: string | null }> {
    const db = getDbClient();
    const limit = Math.min(opts.limit ?? 50, 500);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.tenantId !== undefined) {
      if (opts.includeGlobal) {
        conditions.push('(tenant_id = ? OR tenant_id IS NULL)');
      } else {
        conditions.push('tenant_id = ?');
      }
      params.push(opts.tenantId);
    }

    if (opts.category) {
      conditions.push('category = ?');
      params.push(opts.category);
    }
    if (opts.subcategory) {
      conditions.push('subcategory = ?');
      params.push(opts.subcategory);
    }
    if (opts.entityId) {
      conditions.push('entity_id = ?');
      params.push(opts.entityId);
    }
    if (opts.actorLogin) {
      conditions.push('actor_login = ?');
      params.push(opts.actorLogin);
    }
    if (opts.from !== undefined) {
      conditions.push('occurred_at >= ?');
      params.push(opts.from);
    }
    if (opts.to !== undefined) {
      conditions.push('occurred_at <= ?');
      params.push(opts.to);
    }

    if (opts.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8'));
        conditions.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))');
        params.push(decoded.ts, decoded.ts, decoded.id);
      } catch {
        // ignore malformed cursor
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows: any[] = await db.all(`
      SELECT * FROM ticklers ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `, [...params, limit + 1]);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(mapRow);

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const last = data[data.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ ts: last.occurred_at, id: last.id })).toString('base64url');
    }

    return { data, nextCursor };
  },
};
