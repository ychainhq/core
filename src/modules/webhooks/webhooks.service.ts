import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError } from '../../shared/errors/index';
import { logger } from '../../shared/logging/index';

export interface Webhook {
  id: string;
  tenant_id: string | null;
  url: string;
  events: string[];
  chains: string[] | null;
  wallet_id: string | null;
  is_active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapWebhook(row: any): Webhook {
  return {
    ...row,
    is_active: row.is_active === 1,
    events: row.events ? JSON.parse(row.events) : [],
    chains: row.chains ? JSON.parse(row.chains) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

function mapDelivery(row: any): WebhookDelivery {
  return {
    ...row,
    payload: row.payload ? JSON.parse(row.payload) : null,
  };
}

export const webhooksService = {
  create(tenantId: string, input: {
    url: string;
    events: string[];
    chains?: string[];
    walletId?: string;
    secret?: string;
    metadata?: Record<string, unknown>;
  }): { webhook: Webhook; secret: string } {
    const db = getDb();
    const id = `wh_${crypto.randomBytes(8).toString('hex')}`;
    const secret = input.secret ?? crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO webhooks (id, tenant_id, url, events, chains, wallet_id, secret, is_active, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id,
      tenantId,
      input.url,
      JSON.stringify(input.events),
      input.chains ? JSON.stringify(input.chains) : null,
      input.walletId ?? null,
      secret,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now
    );

    return {
      webhook: webhooksService.getById(tenantId, id),
      secret,
    };
  },

  list(tenantId: string, filters: { walletId?: string; limit?: number; cursor?: string } = {}): {
    data: Webhook[];
    nextCursor: string | null;
  } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    let query = 'SELECT * FROM webhooks WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.walletId) {
      query += ' AND wallet_id = ?';
      params.push(filters.walletId);
    }
    if (filters.cursor) {
      query += ' AND id > ?';
      params.push(filters.cursor);
    }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapWebhook),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  getById(tenantId: string, id: string): Webhook {
    const db = getDb();
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!row) throw new NotFoundError('Webhook', id);
    return mapWebhook(row);
  },

  update(tenantId: string, id: string, input: {
    url?: string;
    events?: string[];
    chains?: string[];
    isActive?: boolean;
  }): Webhook {
    const db = getDb();
    const existing = webhooksService.getById(tenantId, id);
    const now = new Date().toISOString();

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.url !== undefined) { updates.push('url = ?'); params.push(input.url); }
    if (input.events !== undefined) { updates.push('events = ?'); params.push(JSON.stringify(input.events)); }
    if (input.chains !== undefined) { updates.push('chains = ?'); params.push(JSON.stringify(input.chains)); }
    if (input.isActive !== undefined) { updates.push('is_active = ?'); params.push(input.isActive ? 1 : 0); }

    if (updates.length === 0) return existing;

    updates.push('updated_at = ?');
    params.push(now, id, tenantId);

    db.prepare(`UPDATE webhooks SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);
    return webhooksService.getById(tenantId, id);
  },

  deactivate(tenantId: string, id: string): Webhook {
    return webhooksService.update(tenantId, id, { isActive: false });
  },

  getSecret(tenantId: string, id: string): string {
    const db = getDb();
    const row = db.prepare('SELECT secret FROM webhooks WHERE id = ? AND tenant_id = ?').get(id, tenantId) as { secret: string } | undefined;
    if (!row) throw new NotFoundError('Webhook', id);
    return row.secret;
  },

  // Internal lookups without tenant filter — for webhook-delivery worker
  getByIdInternal(id: string): Webhook {
    const db = getDb();
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Webhook', id);
    return mapWebhook(row);
  },

  getSecretInternal(id: string): string {
    const db = getDb();
    const row = db.prepare('SELECT secret FROM webhooks WHERE id = ?').get(id) as { secret: string } | undefined;
    if (!row) throw new NotFoundError('Webhook', id);
    return row.secret;
  },

  /**
   * Queue an event for delivery to matching webhooks.
   * When tenantId is provided, only that tenant's webhooks receive the event.
   * Workers pass tenantId from the watched_address record.
   */
  queueEvent(eventType: string, payload: unknown, chain?: string, walletId?: string, tenantId?: string): void {
    const db = getDb();
    const now = new Date().toISOString();

    let query = 'SELECT * FROM webhooks WHERE is_active = 1';
    const params: unknown[] = [];

    if (tenantId) {
      query += ' AND tenant_id = ?';
      params.push(tenantId);
    }

    const rows = db.prepare(query).all(...params) as any[];

    for (const row of rows) {
      const webhook = mapWebhook(row);

      // Check event type matches
      if (!webhook.events.includes(eventType) && !webhook.events.includes('*')) {
        continue;
      }

      // Check chain filter
      if (chain && webhook.chains && !webhook.chains.includes(chain)) {
        continue;
      }

      // Check wallet filter
      if (walletId && webhook.wallet_id && webhook.wallet_id !== walletId) {
        continue;
      }

      const deliveryId = `wdlv_${crypto.randomBytes(8).toString('hex')}`;
      const eventId = `evt_${crypto.randomBytes(8).toString('hex')}`;

      db.prepare(`
        INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, attempts, next_retry_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(
        deliveryId,
        webhook.id,
        eventId,
        eventType,
        JSON.stringify(payload),
        now,
        now,
        now
      );

      logger.debug('Queued webhook delivery', { deliveryId, eventType, webhookId: webhook.id });
    }
  },

  listDeliveries(tenantId: string, filters: {
    webhookId?: string;
    eventType?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  } = {}): { data: WebhookDelivery[]; nextCursor: string | null } {
    const db = getDb();
    const limit = Math.min(filters.limit ?? 20, 100);
    // Join with webhooks to enforce tenant isolation
    let query = `
      SELECT wd.* FROM webhook_deliveries wd
      JOIN webhooks wh ON wh.id = wd.webhook_id
      WHERE wh.tenant_id = ?
    `;
    const params: unknown[] = [tenantId];

    if (filters.webhookId) { query += ' AND wd.webhook_id = ?'; params.push(filters.webhookId); }
    if (filters.eventType) { query += ' AND wd.event_type = ?'; params.push(filters.eventType); }
    if (filters.status) { query += ' AND wd.status = ?'; params.push(filters.status); }
    if (filters.cursor) { query += ' AND wd.id > ?'; params.push(filters.cursor); }

    query += ' ORDER BY wd.created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: items.map(mapDelivery),
      nextCursor: hasMore ? (items[items.length - 1] as any).id : null,
    };
  },

  getDeliveryById(tenantId: string, id: string): WebhookDelivery {
    const db = getDb();
    const row = db.prepare(`
      SELECT wd.* FROM webhook_deliveries wd
      JOIN webhooks wh ON wh.id = wd.webhook_id
      WHERE wd.id = ? AND wh.tenant_id = ?
    `).get(id, tenantId);
    if (!row) throw new NotFoundError('WebhookDelivery', id);
    return mapDelivery(row);
  },

  retryDelivery(tenantId: string, id: string): WebhookDelivery {
    const db = getDb();
    const now = new Date().toISOString();
    const existing = webhooksService.getDeliveryById(tenantId, id);
    db.prepare(`
      UPDATE webhook_deliveries SET status = 'pending', next_retry_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, id);
    return { ...existing, status: 'pending', next_retry_at: now };
  },

  /**
   * Sign a webhook payload with HMAC-SHA256.
   * Signature: HMAC-SHA256(secret, timestamp + "." + JSON.stringify(payload))
   */
  signPayload(secret: string, timestamp: number, payload: unknown): string {
    const message = `${timestamp}.${JSON.stringify(payload)}`;
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
  },
};
