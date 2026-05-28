import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
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
    try {
      const db = getDb();
      const id = `tck_${crypto.randomBytes(8).toString('hex')}`;
      db.prepare(`
        INSERT INTO ticklers
          (id, occurred_at, tenant_id, category, subcategory, entity_id, actor_login,
           field1, field2, field3, field4, field5, prev_value, new_value)
        VALUES
          (@id, @occurred_at, @tenant_id, @category, @subcategory, @entity_id, @actor_login,
           @field1, @field2, @field3, @field4, @field5, @prev_value, @new_value)
      `).run({
        id,
        occurred_at: Date.now(),
        tenant_id: payload.tenantId ?? null,
        category: payload.category,
        subcategory: payload.subcategory,
        entity_id: payload.entityId ?? null,
        actor_login: payload.actorLogin ?? null,
        field1: payload.field1 ?? null,
        field2: payload.field2 ?? null,
        field3: payload.field3 ?? null,
        field4: payload.field4 ?? null,
        field5: payload.field5 ?? null,
        prev_value: serializeValue(payload.prevValue),
        new_value: serializeValue(payload.newValue),
      });
    } catch (err) {
      logger.warn('tickler write failed', { err: String(err), category: payload.category, subcategory: payload.subcategory });
    }
  },

  list(opts: {
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
  }): { data: TicklerRecord[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(opts.limit ?? 50, 500);

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.tenantId !== undefined) {
      if (opts.includeGlobal) {
        conditions.push('(tenant_id = @tenantId OR tenant_id IS NULL)');
      } else {
        conditions.push('tenant_id = @tenantId');
      }
      params.tenantId = opts.tenantId;
    }

    if (opts.category) {
      conditions.push('category = @category');
      params.category = opts.category;
    }
    if (opts.subcategory) {
      conditions.push('subcategory = @subcategory');
      params.subcategory = opts.subcategory;
    }
    if (opts.entityId) {
      conditions.push('entity_id = @entityId');
      params.entityId = opts.entityId;
    }
    if (opts.actorLogin) {
      conditions.push('actor_login = @actorLogin');
      params.actorLogin = opts.actorLogin;
    }
    if (opts.from !== undefined) {
      conditions.push('occurred_at >= @from');
      params.from = opts.from;
    }
    if (opts.to !== undefined) {
      conditions.push('occurred_at <= @to');
      params.to = opts.to;
    }

    if (opts.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8'));
        conditions.push('(occurred_at < @cursorTs OR (occurred_at = @cursorTs AND id < @cursorId))');
        params.cursorTs = decoded.ts;
        params.cursorId = decoded.id;
      } catch {
        // ignore malformed cursor
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows: any[] = db.prepare(`
      SELECT * FROM ticklers ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT @limit
    `).all({ ...params, limit: limit + 1 });

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
