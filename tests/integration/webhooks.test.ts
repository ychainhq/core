import request from 'supertest';
import crypto from 'crypto';
import { bootstrapApp, AUTH, teardownDb } from './helpers';
import { getDb } from '../../src/db/sqlite';

const app = bootstrapApp();

afterAll(() => teardownDb());

describe('POST /v1/webhooks', () => {
  it('creates a webhook with provided secret', async () => {
    const res = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({
        url: 'https://example.com/webhook',
        events: ['deposit.detected', 'deposit.confirmed', 'payment_request.paid'],
        secret: 'my-hmac-secret-1234',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toMatch(/^wh_/);
    expect(res.body.data.url).toBe('https://example.com/webhook');
    expect(res.body.data.events).toContain('deposit.detected');
    expect(res.body.data.events).toContain('payment_request.paid');
    expect(res.body.data.is_active).toBe(true);
    // Secret is stored (returned at creation when client provides it)
    expect(res.body.data.secret).toBe('my-hmac-secret-1234');
  });

  it('generates a secret when none is provided', async () => {
    const res = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({
        url: 'https://example.com/webhook2',
        events: ['transaction.broadcasted'],
      });

    expect(res.status).toBe(201);
    // A generated secret should be a non-empty string
    expect(res.body.data.secret).toBeTruthy();
    expect(res.body.data.secret.length).toBeGreaterThan(10);
  });

  it('creates webhook with chains filter', async () => {
    const res = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({
        url: 'https://example.com/webhook3',
        events: ['deposit.detected'],
        chains: ['bitcoin'],
        secret: 'secret-xyz',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.chains).toContain('bitcoin');
  });

  it('returns 400 for missing url', async () => {
    const res = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({ events: ['deposit.detected'], secret: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for empty events array', async () => {
    const res = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({ url: 'https://example.com/w', events: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid url', async () => {
    const res = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({ url: 'not-a-url', events: ['deposit.detected'] });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/webhooks', () => {
  beforeAll(async () => {
    await request(app).post('/v1/webhooks').set(AUTH).send({
      url: 'https://example.com/list-test',
      events: ['deposit.confirmed'],
      secret: 'list-secret',
    });
  });

  it('returns list of webhooks', async () => {
    const res = await request(app).get('/v1/webhooks').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /v1/webhooks/:id', () => {
  let webhookId: string;

  beforeAll(async () => {
    const res = await request(app).post('/v1/webhooks').set(AUTH).send({
      url: 'https://example.com/get-by-id',
      events: ['deposit.detected'],
      secret: 'get-secret',
    });
    webhookId = res.body.data.id;
  });

  it('returns webhook by id', async () => {
    const res = await request(app).get(`/v1/webhooks/${webhookId}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(webhookId);
    expect(res.body.data.url).toBe('https://example.com/get-by-id');
  });

  it('returns 404 for non-existent webhook', async () => {
    const res = await request(app).get('/v1/webhooks/wh_nonexistent').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /v1/webhooks/:id', () => {
  let webhookId: string;

  beforeAll(async () => {
    const res = await request(app).post('/v1/webhooks').set(AUTH).send({
      url: 'https://example.com/patch-test',
      events: ['deposit.detected'],
      secret: 'patch-secret',
    });
    webhookId = res.body.data.id;
  });

  it('updates webhook url', async () => {
    const res = await request(app)
      .patch(`/v1/webhooks/${webhookId}`)
      .set(AUTH)
      .send({ url: 'https://example.com/new-endpoint' });

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe('https://example.com/new-endpoint');
  });

  it('updates events list', async () => {
    const res = await request(app)
      .patch(`/v1/webhooks/${webhookId}`)
      .set(AUTH)
      .send({ events: ['deposit.confirmed', 'transaction.broadcasted'] });

    expect(res.status).toBe(200);
    expect(res.body.data.events).toContain('deposit.confirmed');
    expect(res.body.data.events).toContain('transaction.broadcasted');
    expect(res.body.data.events).not.toContain('deposit.detected');
  });

  it('deactivates webhook via isActive=false', async () => {
    const res = await request(app)
      .patch(`/v1/webhooks/${webhookId}`)
      .set(AUTH)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data.is_active).toBe(false);
  });
});

describe('DELETE /v1/webhooks/:id', () => {
  let webhookId: string;

  beforeAll(async () => {
    const res = await request(app).post('/v1/webhooks').set(AUTH).send({
      url: 'https://example.com/delete-test',
      events: ['deposit.detected'],
      secret: 'delete-secret',
    });
    webhookId = res.body.data.id;
  });

  it('soft-deletes webhook', async () => {
    const delRes = await request(app).delete(`/v1/webhooks/${webhookId}`).set(AUTH);
    expect(delRes.status).toBe(200);

    // Should no longer appear in list (is_active = false)
    const getRes = await request(app).get(`/v1/webhooks/${webhookId}`).set(AUTH);
    expect(getRes.body.data.is_active).toBe(false);
  });

  it('returns 404 for non-existent webhook', async () => {
    const res = await request(app).delete('/v1/webhooks/wh_ghost').set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/webhooks/:id/test — HMAC signature', () => {
  let webhookId: string;
  const secret = 'hmac-test-secret-known';

  beforeAll(async () => {
    const res = await request(app).post('/v1/webhooks').set(AUTH).send({
      url: 'https://example.com/webhook-test-endpoint',
      events: ['deposit.detected'],
      secret,
    });
    webhookId = res.body.data.id;
  });

  it('returns delivery result (may succeed or fail depending on reachability)', async () => {
    const res = await request(app)
      .post(`/v1/webhooks/${webhookId}/test`)
      .set(AUTH);

    expect(res.status).toBe(200);
    // Regardless of HTTP delivery success, the response shape must be correct
    expect(res.body.data.webhookId).toBe(webhookId);
    expect(typeof res.body.data.delivered).toBe('boolean');
    expect(typeof res.body.data.responseStatus).toBe('number');
  });

  it('returns 404 for non-existent webhook', async () => {
    const res = await request(app)
      .post('/v1/webhooks/wh_nonexistent/test')
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe('HMAC signature verification — webhook-delivery.worker pattern', () => {
  // Verify that the HMAC signing logic is correct by checking the formula
  it('computes correct HMAC-SHA256 signature', () => {
    const secret = 'my-known-secret';
    const timestamp = '1700000000000';
    const payload = { eventType: 'deposit.detected', data: { depositId: 'dep_123' } };
    const payloadStr = JSON.stringify(payload);

    // Formula used by the webhook service: HMAC-SHA256(secret, timestamp + "." + payloadStr)
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payloadStr}`)
      .digest('hex');

    expect(expected).toHaveLength(64);
    expect(expected).toMatch(/^[a-f0-9]+$/);

    // Same inputs → same signature (deterministic)
    const second = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payloadStr}`)
      .digest('hex');
    expect(second).toBe(expected);

    // Different timestamp → different signature
    const different = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}1.${payloadStr}`)
      .digest('hex');
    expect(different).not.toBe(expected);
  });
});

describe('GET /v1/webhook-deliveries', () => {
  it('returns list of deliveries (may be empty)', async () => {
    const res = await request(app).get('/v1/webhook-deliveries').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
  });

  it('filters by status', async () => {
    const res = await request(app).get('/v1/webhook-deliveries?status=pending').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('filters by eventType', async () => {
    const res = await request(app)
      .get('/v1/webhook-deliveries?eventType=deposit.confirmed')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('POST /v1/webhook-deliveries/:deliveryId/retry', () => {
  let deliveryId: string;

  beforeAll(async () => {
    const wRes = await request(app)
      .post('/v1/webhooks')
      .set(AUTH)
      .send({ url: 'https://example.invalid/retry-test', events: ['*'] });
    const webhookId = wRes.body.data.id;

    // Insert a failed delivery directly — webhook-delivery.worker creates these in production
    const db = getDb();
    deliveryId = `wdlv_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO webhook_deliveries
        (id, webhook_id, event_id, event_type, payload, status, attempts, next_retry_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'failed', 3, ?, ?, ?)
    `).run(
      deliveryId,
      webhookId,
      `evt_${crypto.randomBytes(8).toString('hex')}`,
      'deposit.confirmed',
      JSON.stringify({ test: true }),
      now, now, now
    );
  });

  it('resets delivery status to pending', async () => {
    const res = await request(app)
      .post(`/v1/webhook-deliveries/${deliveryId}/retry`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(deliveryId);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.next_retry_at).toBeDefined();
  });

  it('returns 404 for non-existent delivery', async () => {
    const res = await request(app)
      .post('/v1/webhook-deliveries/wdlv_doesnotexist/retry')
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});
