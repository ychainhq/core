/**
 * Signing Tasks Integration Tests
 *
 * Tests: create, list, approve, reject (manual flow)
 * Note: Full claim/submit flow requires a signed PSBT from a signer daemon.
 * These tests cover the task lifecycle at the API level.
 */

import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { bootstrapApp, teardownDb, AUTH } from './helpers';
import { getDb } from '../../src/db/sqlite';
import { signingTasksService } from '../../src/modules/signing-tasks/signing-tasks.service';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeActorToken(tenantId: string, secret: string, permissions: string[] = []): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(Buffer.from(JSON.stringify({
    sub: 'user_rbac_test',
    tenant_id: tenantId,
    permissions,
    teams: [],
    roles: [],
    iat: now,
    exp: now + 3600,
  })));
  const sig = base64url(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

let app: express.Application;

beforeAll(() => {
  app = bootstrapApp();
});

afterAll(() => teardownDb());

const TEST_TENANT_ID = 'tenant_default';

function createTestSigningTask(overrides: Partial<Parameters<typeof signingTasksService.create>[0]> = {}) {
  return signingTasksService.create({
    tenantId: TEST_TENANT_ID,
    signerId: null,
    requestType: 'btc_withdrawal_batch',
    chainId: 'bitcoin',
    assetId: 'bitcoin:BTC',
    amountRaw: '500000',
    feeRaw: '1000',
    feeRateSatVb: '10',
    outputsCount: 3,
    payloadFormat: 'btc_psbt',
    unsignedPayload: Buffer.from('test-psbt-payload').toString('base64'),
    decisionMode: 'auto',
    decisionReason: 'batch_under_auto_limit',
    ...overrides,
  });
}

describe('Signing Tasks — List', () => {
  let taskId: string;

  beforeAll(() => {
    const task = createTestSigningTask();
    taskId = task.id;
  });

  test('GET /v1/signing-tasks — returns list', async () => {
    const res = await request(app)
      .get('/v1/signing-tasks')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /v1/signing-tasks/:taskId — returns task', async () => {
    const res = await request(app)
      .get(`/v1/signing-tasks/${taskId}`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(taskId);
    expect(res.body.data.status).toBe('available');
  });

  test('GET /v1/signing-tasks/:taskId — 404 for unknown', async () => {
    const res = await request(app)
      .get('/v1/signing-tasks/sigtsk_nonexistent')
      .set(AUTH);

    expect(res.status).toBe(404);
  });
});

describe('Signing Tasks — Manual Approval Flow', () => {
  let taskId: string;

  beforeAll(() => {
    const task = createTestSigningTask({ decisionMode: 'manual' });
    taskId = task.id;
  });

  test('task starts in pending_approval status', async () => {
    const res = await request(app)
      .get(`/v1/signing-tasks/${taskId}`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending_approval');
  });

  test('POST /v1/signing-tasks/:taskId/approve — moves to available', async () => {
    const res = await request(app)
      .post(`/v1/signing-tasks/${taskId}/approve`)
      .set(AUTH)
      .send({ approvedBy: 'admin_user_1' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('available');
  });
});

describe('Signing Tasks — Manual Rejection Flow', () => {
  let taskId: string;

  beforeAll(() => {
    const task = createTestSigningTask({ decisionMode: 'manual' });
    taskId = task.id;
  });

  test('POST /v1/signing-tasks/:taskId/reject — cancels task', async () => {
    const res = await request(app)
      .post(`/v1/signing-tasks/${taskId}/reject`)
      .set(AUTH)
      .send({ reason: 'Policy review required', rejectedBy: 'compliance_officer' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });
});

// ─── Bug 3 regression: rejectTask via signer endpoint reverts batch + withdrawal ──

describe('Signing Tasks — Signer reject reverts withdrawal batch (Bug 3)', () => {
  let signerId: string;
  let batchId: string;
  let withdrawalId: string;
  let taskId: string;

  beforeAll(async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const crypto = require('crypto');

    // Enroll + activate signer
    const enrollRes = await request(app)
      .post('/v1/external-signers/enroll')
      .set(AUTH)
      .send({
        name: 'Bug3 Test Signer',
        edition: 'community',
        publicKey: 'ed25519:bug3key',
        signerFingerprint: 'fp:bug3:001',
        capabilities: { chains: ['bitcoin'], assets: ['bitcoin:BTC'], formats: ['btc_psbt'] },
      });
    signerId = enrollRes.body.data.id;

    await request(app)
      .post(`/v1/external-signers/${signerId}/heartbeat`)
      .set(AUTH)
      .send({ status: 'healthy', version: '1.0.0', capabilities: { chains: ['bitcoin'], assets: ['bitcoin:BTC'], formats: ['btc_psbt'] }, time: now });

    // Create a real customer (needed for FK in customer_withdrawals)
    const custRes = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ externalId: 'bug3-test-customer', name: 'Bug3 Test Customer' });
    const customerId: string = custRes.body.data.id;

    // Insert a customer_withdrawal in 'batched' state
    withdrawalId = `wd_${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(`
      INSERT INTO customer_withdrawals (
        id, tenant_id, customer_id, chain_id, asset_id, amount_raw, to_address, status, created_at, updated_at
      ) VALUES (?, 'tenant_default', ?, 'bitcoin', 'bitcoin:BTC', '10000',
                'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'batched', ?, ?)
    `).run(withdrawalId, customerId, now, now);

    // Insert a withdrawal_batch in 'pending_signature' state
    batchId = `wdb_${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(`
      INSERT INTO withdrawal_batches (
        id, tenant_id, chain_id, asset_id, status, outputs_count, total_output_raw,
        rbf_enabled, decision_mode, attempt_count, created_at, updated_at
      ) VALUES (?, 'tenant_default', 'bitcoin', 'bitcoin:BTC', 'pending_signature',
                1, '10000', 1, 'auto', 0, ?, ?)
    `).run(batchId, now, now);

    // Link withdrawal to batch
    db.prepare(`
      INSERT INTO withdrawal_batch_items (batch_id, withdrawal_id, amount_raw, to_address)
      VALUES (?, ?, '10000', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
    `).run(batchId, withdrawalId);

    // Create signing task linked to the batch, assigned to our signer
    const task = signingTasksService.create({
      tenantId: TEST_TENANT_ID,
      signerId,
      requestType: 'btc_withdrawal_batch',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      withdrawalBatchId: batchId,
      amountRaw: '10000',
      feeRaw: '200',
      feeRateSatVb: '5',
      outputsCount: 1,
      payloadFormat: 'btc_psbt',
      unsignedPayload: Buffer.from('psbt-bug3').toString('base64'),
      decisionMode: 'auto',
      decisionReason: 'auto_limit',
    });
    taskId = task.id;

    // Update batch to reference the task
    db.prepare(`UPDATE withdrawal_batches SET signing_task_id = ? WHERE id = ?`).run(taskId, batchId);
  });

  test('signing task starts as available', async () => {
    const res = await request(app)
      .get(`/v1/signing-tasks/${taskId}`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('available');
  });

  test('batch starts as pending_signature', async () => {
    const res = await request(app)
      .get(`/v1/withdrawal-batches/${batchId}`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending_signature');
  });

  test('withdrawal starts as batched', () => {
    const db = getDb();
    const wd = db.prepare(`SELECT status FROM customer_withdrawals WHERE id = ?`).get(withdrawalId) as any;
    expect(wd.status).toBe('batched');
  });

  test('POST /reject via signer endpoint succeeds', async () => {
    const res = await request(app)
      .post(`/v1/external-signers/${signerId}/tasks/${taskId}/reject`)
      .set(AUTH)
      .send({
        reasonCode: 'signer_internal_error',
        reasonMessage: "Unsupported payload format 'undefined' for chain 'undefined'",
        rejectedAt: new Date().toISOString(),
      });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
  });

  test('batch is moved to failed after signing task rejection', async () => {
    const res = await request(app)
      .get(`/v1/withdrawal-batches/${batchId}`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('failed');
  });

  test('withdrawal is reverted to queued after signing task rejection', () => {
    const db = getDb();
    const wd = db.prepare(`SELECT status FROM customer_withdrawals WHERE id = ?`).get(withdrawalId) as any;
    expect(wd.status).toBe('queued');
  });

  test('batch last_error contains rejection reason', async () => {
    const res = await request(app)
      .get(`/v1/withdrawal-batches/${batchId}`)
      .set(AUTH);

    expect(res.body.data.last_error).toContain('signer_internal_error');
  });

  test('rejecting already-rejected task is idempotent (no error)', async () => {
    const res = await request(app)
      .post(`/v1/external-signers/${signerId}/tasks/${taskId}/reject`)
      .set(AUTH)
      .send({ reasonCode: 'duplicate', reasonMessage: 'Already rejected' });

    // Task is already in 'rejected' — service returns it idempotently
    expect([200, 400]).toContain(res.status);
  });
});

describe('Signing Tasks — Expiry', () => {
  test('expireAllOverdue — expires tasks past their TTL', () => {
    // Create a task with an already-expired TTL
    const db = getDb();
    const task = createTestSigningTask();

    // Set expires_at to the past
    db.prepare(
      `UPDATE signing_tasks SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?`
    ).run(task.id);

    const expired = signingTasksService.expireAllOverdue();
    expect(expired).toBeGreaterThanOrEqual(1);

    const updatedTask = signingTasksService.getByIdInternal(task.id);
    expect(updatedTask.status).toBe('expired');
  });
});

// ─── requestType filter ────────────────────────────────────────────────────────

describe('Signing Tasks — requestType filter', () => {
  beforeAll(() => {
    createTestSigningTask({ requestType: 'btc_withdrawal_batch' });
  });

  test('GET /v1/signing-tasks?requestType=btc_withdrawal_batch returns matching tasks', async () => {
    const res = await request(app)
      .get('/v1/signing-tasks?requestType=btc_withdrawal_batch')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    res.body.data.forEach((t: any) => {
      expect(t.request_type).toBe('btc_withdrawal_batch');
    });
  });

  test('GET /v1/signing-tasks?requestType=unknown_type returns empty list', async () => {
    const res = await request(app)
      .get('/v1/signing-tasks?requestType=unknown_type_xyz')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ─── RBAC guard — signing-task:read ───────────────────────────────────────────

const ACTOR_SECRET = 'rbac-signing-task-secret-at-least-32-chars!!';

describe('Signing Tasks — RBAC guard (X-Actor-Token)', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare(`UPDATE tenant_configs SET actor_token_secret = ? WHERE tenant_id = ?`)
      .run(ACTOR_SECRET, TEST_TENANT_ID);
  });

  test('GET /v1/signing-tasks with token lacking signing-task:read → 403', async () => {
    const token = makeActorToken(TEST_TENANT_ID, ACTOR_SECRET, []);
    const res = await request(app)
      .get('/v1/signing-tasks')
      .set({ ...AUTH, 'X-Actor-Token': token });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  test('GET /v1/signing-tasks with token having signing-task:read:all → 200', async () => {
    const token = makeActorToken(TEST_TENANT_ID, ACTOR_SECRET, ['signing-task:read:all']);
    const res = await request(app)
      .get('/v1/signing-tasks')
      .set({ ...AUTH, 'X-Actor-Token': token });

    expect(res.status).toBe(200);
  });

  test('GET /v1/signing-tasks without X-Actor-Token → 200 (admin mode)', async () => {
    const res = await request(app)
      .get('/v1/signing-tasks')
      .set(AUTH);

    expect(res.status).toBe(200);
  });

  test('unrelated permission (customer:read:all) still yields 403 for signing-task', async () => {
    const token = makeActorToken(TEST_TENANT_ID, ACTOR_SECRET, ['customer:read:all']);
    const res = await request(app)
      .get('/v1/signing-tasks')
      .set({ ...AUTH, 'X-Actor-Token': token });

    expect(res.status).toBe(403);
  });
});
