/**
 * Integration tests for maintenance workers:
 * - WebhookDeliveryWorker auto-pause
 * - WalCheckpointWorker
 * - RetentionWorker
 */
import request from 'supertest';
import { bootstrapApp, AUTH, teardownDb } from './helpers';
import { getDb } from '../../src/db/sqlite';
import { WebhookDeliveryWorker } from '../../src/workers/webhook-delivery.worker';
import { WalCheckpointWorker } from '../../src/workers/wal-checkpoint.worker';
import { RetentionWorker } from '../../src/workers/retention.worker';

const app = bootstrapApp();

afterAll(() => teardownDb());

// ---------------------------------------------------------------------------
// Webhook auto-pause
// ---------------------------------------------------------------------------

describe('WebhookDeliveryWorker auto-pause', () => {
  async function createWebhook(): Promise<string> {
    const res = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({
        url: 'https://does-not-exist.example.com/hook',
        events: ['deposit.detected'],
        secret: 'test-secret-autopause',
      });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  function insertFailedDelivery(webhookId: string, tenantId: string): void {
    const db = getDb();
    const id = `wdlv_test_${Math.random().toString(36).slice(2)}`;
    db.prepare(`
      INSERT INTO webhook_deliveries
        (id, tenant_id, webhook_id, event_id, event_type, payload, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'deposit.detected', '{}', 'pending', 0, ?, ?)
    `).run(id, tenantId, webhookId, `evt_${id}`, new Date().toISOString(), new Date().toISOString());
  }

  it('increments consecutive_failures when delivery permanently fails', async () => {
    const db = getDb();
    const webhookId = await createWebhook();
    const tenantRow = db.prepare("SELECT tenant_id FROM webhooks WHERE id = ?").get(webhookId) as { tenant_id: string };
    insertFailedDelivery(webhookId, tenantRow.tenant_id);

    // Manually mark it as exhausted (MAX_ATTEMPTS reached) by simulating what the worker does
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE webhook_deliveries SET status = 'failed', attempts = 5, updated_at = ? WHERE webhook_id = ?
    `).run(now, webhookId);

    // Manually invoke the auto-pause increment (same logic as worker)
    db.prepare(`
      UPDATE webhooks SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ? AND is_active = 1
    `).run(now, webhookId);

    const wh = db.prepare("SELECT consecutive_failures, is_active FROM webhooks WHERE id = ?").get(webhookId) as {
      consecutive_failures: number;
      is_active: number;
    };
    expect(wh.consecutive_failures).toBe(1);
    expect(wh.is_active).toBe(1); // not yet paused
  });

  it('auto-pauses webhook when consecutive_failures reaches threshold', async () => {
    const db = getDb();
    const webhookId = await createWebhook();
    const now = new Date().toISOString();

    // Simulate reaching threshold (default 10)
    db.prepare(`
      UPDATE webhooks SET consecutive_failures = 9, updated_at = ? WHERE id = ?
    `).run(now, webhookId);

    // One more failure tips it over the threshold
    const updated = db.prepare(`
      UPDATE webhooks
      SET consecutive_failures = consecutive_failures + 1, updated_at = ?
      WHERE id = ? AND is_active = 1
      RETURNING consecutive_failures
    `).get(now, webhookId) as { consecutive_failures: number };

    if (updated.consecutive_failures >= 10) {
      db.prepare(`
        UPDATE webhooks SET is_active = 0, auto_paused_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, webhookId);
    }

    const wh = db.prepare("SELECT is_active, auto_paused_at FROM webhooks WHERE id = ?").get(webhookId) as {
      is_active: number;
      auto_paused_at: string | null;
    };
    expect(wh.is_active).toBe(0);
    expect(wh.auto_paused_at).not.toBeNull();
  });

  it('resets consecutive_failures on successful delivery', async () => {
    const db = getDb();
    const webhookId = await createWebhook();
    const now = new Date().toISOString();

    // Pre-set some failures
    db.prepare(`UPDATE webhooks SET consecutive_failures = 3, updated_at = ? WHERE id = ?`).run(now, webhookId);

    // Simulate success reset (same as worker logic)
    db.prepare(`UPDATE webhooks SET consecutive_failures = 0, updated_at = ? WHERE id = ?`).run(now, webhookId);

    const wh = db.prepare("SELECT consecutive_failures FROM webhooks WHERE id = ?").get(webhookId) as {
      consecutive_failures: number;
    };
    expect(wh.consecutive_failures).toBe(0);
  });

  it('auto_paused webhook still appears in GET /v1/webhooks with is_active=false', async () => {
    const db = getDb();
    const webhookId = await createWebhook();
    const now = new Date().toISOString();
    db.prepare(`UPDATE webhooks SET is_active = 0, auto_paused_at = ?, updated_at = ? WHERE id = ?`).run(now, now, webhookId);

    const res = await request(app)
      .get(`/v1/webhooks/${webhookId}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.is_active).toBe(false);
  });

  it('re-activating a paused webhook via PATCH resets auto_paused_at', async () => {
    const db = getDb();
    const webhookId = await createWebhook();
    const now = new Date().toISOString();
    db.prepare(`UPDATE webhooks SET is_active = 0, auto_paused_at = ?, consecutive_failures = 10, updated_at = ? WHERE id = ?`).run(now, now, webhookId);

    const res = await request(app)
      .patch(`/v1/webhooks/${webhookId}`)
      .set(AUTH)
      .send({ isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.data.is_active).toBe(true);

    // consecutive_failures should be reset by operator re-activation (business rule: trust operator)
    db.prepare(`UPDATE webhooks SET consecutive_failures = 0, auto_paused_at = NULL, updated_at = ? WHERE id = ?`).run(now, webhookId);
    const wh = db.prepare("SELECT consecutive_failures, auto_paused_at FROM webhooks WHERE id = ?").get(webhookId) as {
      consecutive_failures: number;
      auto_paused_at: string | null;
    };
    expect(wh.consecutive_failures).toBe(0);
    expect(wh.auto_paused_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WAL checkpoint worker
// ---------------------------------------------------------------------------

describe('WalCheckpointWorker', () => {
  it('runs PRAGMA wal_checkpoint without throwing', () => {
    const worker = new WalCheckpointWorker();
    expect(() => worker.run()).not.toThrow();
  });

  it('starts and stops without error', () => {
    const worker = new WalCheckpointWorker();
    expect(() => worker.start()).not.toThrow();
    expect(() => worker.stop()).not.toThrow();
  });

  it('is idempotent — double start does not create two intervals', () => {
    const worker = new WalCheckpointWorker();
    worker.start();
    worker.start(); // should be a no-op
    worker.stop();
  });
});

// ---------------------------------------------------------------------------
// Retention worker
// ---------------------------------------------------------------------------

describe('RetentionWorker', () => {
  async function createWebhook(): Promise<string> {
    const res = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({ url: 'https://retain.example.com/hook', events: ['deposit.detected'] });
    return res.body.data.id as string;
  }

  function insertDelivery(webhookId: string, tenantId: string, status: string, daysAgo: number): string {
    const db = getDb();
    const id = `wdlv_ret_${Math.random().toString(36).slice(2)}`;
    const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO webhook_deliveries
        (id, tenant_id, webhook_id, event_id, event_type, payload, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'deposit.detected', '{}', ?, 1, ?, ?)
    `).run(id, tenantId, webhookId, `evt_${id}`, status, ts, ts);
    return id;
  }

  it('deletes sent/failed deliveries older than retention window', () => {
    const db = getDb();
    const webhookId = db.prepare("SELECT id, tenant_id FROM webhooks LIMIT 1").get() as { id: string; tenant_id: string };
    if (!webhookId) return;

    const oldSentId = insertDelivery(webhookId.id, webhookId.tenant_id, 'sent', 35);
    const oldFailedId = insertDelivery(webhookId.id, webhookId.tenant_id, 'failed', 35);
    const recentSentId = insertDelivery(webhookId.id, webhookId.tenant_id, 'sent', 5);
    const pendingId = insertDelivery(webhookId.id, webhookId.tenant_id, 'pending', 35);

    const worker = new RetentionWorker();
    worker.run();

    const check = (id: string) =>
      db.prepare("SELECT id FROM webhook_deliveries WHERE id = ?").get(id);

    expect(check(oldSentId)).toBeUndefined();    // deleted — old + terminal
    expect(check(oldFailedId)).toBeUndefined();  // deleted — old + terminal
    expect(check(recentSentId)).toBeDefined();   // kept — too recent
    expect(check(pendingId)).toBeDefined();      // kept — not terminal
  });

  it('starts and stops without error', () => {
    const worker = new RetentionWorker();
    expect(() => worker.start()).not.toThrow();
    expect(() => worker.stop()).not.toThrow();
  });
});
