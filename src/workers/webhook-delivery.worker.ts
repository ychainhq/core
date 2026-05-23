import { getDb } from '../db/sqlite';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_SECONDS = 60; // 1 minute base, doubles each attempt

function autoPauseThreshold(): number {
  return config.WEBHOOK_AUTO_PAUSE_THRESHOLD;
}

/**
 * WebhookDeliveryWorker
 *
 * Delivers queued webhook events with exponential backoff retry.
 * Runs every WEBHOOK_DELIVERY_INTERVAL_MS (default: 10 seconds).
 */
export class WebhookDeliveryWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('WebhookDeliveryWorker started', { intervalMs: config.WEBHOOK_DELIVERY_INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('WebhookDeliveryWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, config.WEBHOOK_DELIVERY_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('WebhookDeliveryWorker stopped');
    }
  }

  async run(): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();

    // Fetch up to 20 pending deliveries that are due
    const pending = db
      .prepare(`
        SELECT * FROM webhook_deliveries
        WHERE status IN ('pending', 'retrying')
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY created_at ASC
        LIMIT 20
      `)
      .all(now) as any[];

    if (pending.length === 0) return;

    logger.debug('WebhookDeliveryWorker processing deliveries', { count: pending.length });

    for (const delivery of pending) {
      await this.deliverOne(delivery);
    }
  }

  private async deliverOne(delivery: any): Promise<void> {
    const db = getDb();
    const nowIso = new Date().toISOString();

    let webhook: any;
    try {
      webhook = webhooksService.getByIdInternal(delivery.webhook_id);
    } catch {
      // Webhook deleted — mark delivery as failed
      db.prepare(`
        UPDATE webhook_deliveries SET status = 'failed', last_error = 'Webhook not found', updated_at = ? WHERE id = ?
      `).run(nowIso, delivery.id);
      return;
    }

    if (!webhook.is_active) {
      db.prepare(`
        UPDATE webhook_deliveries SET status = 'failed', last_error = 'Webhook inactive', updated_at = ? WHERE id = ?
      `).run(nowIso, delivery.id);
      return;
    }

    const secret = webhooksService.getSecretInternal(webhook.id);
    const timestamp = Date.now();
    const payload = JSON.parse(delivery.payload);

    const fullPayload = {
      eventId: delivery.event_id,
      eventType: delivery.event_type,
      timestamp: new Date(timestamp).toISOString(),
      data: payload,
    };

    const signature = webhooksService.signPayload(secret, timestamp, fullPayload);

    let success = false;
    let errorMessage: string | null = null;

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CryptoApi-Event-Id': delivery.event_id,
          'X-CryptoApi-Timestamp': String(timestamp),
          'X-CryptoApi-Signature': signature,
        },
        body: JSON.stringify(fullPayload),
        signal: AbortSignal.timeout(15000),
      });

      if (response.status >= 200 && response.status < 300) {
        success = true;
      } else {
        errorMessage = `HTTP ${response.status}`;
      }
    } catch (err: any) {
      errorMessage = err.message || 'Network error';
    }

    const newAttempts = (delivery.attempts ?? 0) + 1;

    if (success) {
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'sent', attempts = ?, delivered_at = ?, updated_at = ?
        WHERE id = ?
      `).run(newAttempts, nowIso, nowIso, delivery.id);
      // Successful delivery resets the consecutive failure counter
      db.prepare(`
        UPDATE webhooks SET consecutive_failures = 0, updated_at = ? WHERE id = ?
      `).run(nowIso, delivery.webhook_id);
      logger.debug('Webhook delivered', { deliveryId: delivery.id, eventType: delivery.event_type });
    } else {
      if (newAttempts >= MAX_ATTEMPTS) {
        db.prepare(`
          UPDATE webhook_deliveries
          SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?
          WHERE id = ?
        `).run(newAttempts, errorMessage, nowIso, delivery.id);
        logger.warn('Webhook delivery failed permanently', {
          deliveryId: delivery.id,
          attempts: newAttempts,
          error: errorMessage,
        });

        // Increment consecutive_failures; auto-pause webhook if threshold reached
        const updated = db.prepare(`
          UPDATE webhooks
          SET consecutive_failures = consecutive_failures + 1, updated_at = ?
          WHERE id = ? AND is_active = 1
          RETURNING consecutive_failures
        `).get(nowIso, delivery.webhook_id) as { consecutive_failures: number } | undefined;

        if (updated && updated.consecutive_failures >= autoPauseThreshold()) {
          db.prepare(`
            UPDATE webhooks
            SET is_active = 0, auto_paused_at = ?, updated_at = ?
            WHERE id = ?
          `).run(nowIso, nowIso, delivery.webhook_id);
          logger.warn('Webhook auto-paused due to consecutive failures', {
            webhookId: delivery.webhook_id,
            consecutiveFailures: updated.consecutive_failures,
          });
        }
      } else {
        // Exponential backoff: 1min, 2min, 4min, 8min, ...
        const backoffSeconds = BACKOFF_BASE_SECONDS * Math.pow(2, newAttempts - 1);
        const nextRetry = new Date(Date.now() + backoffSeconds * 1000).toISOString();

        db.prepare(`
          UPDATE webhook_deliveries
          SET status = 'retrying', attempts = ?, last_error = ?, next_retry_at = ?, updated_at = ?
          WHERE id = ?
        `).run(newAttempts, errorMessage, nextRetry, nowIso, delivery.id);
        logger.debug('Webhook delivery scheduled for retry', {
          deliveryId: delivery.id,
          attempt: newAttempts,
          nextRetry,
          error: errorMessage,
        });
      }
    }
  }
}
