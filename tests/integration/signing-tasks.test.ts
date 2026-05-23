/**
 * Signing Tasks Integration Tests
 *
 * Tests: create, list, approve, reject (manual flow)
 * Note: Full claim/submit flow requires a signed PSBT from a signer daemon.
 * These tests cover the task lifecycle at the API level.
 */

import request from 'supertest';
import express from 'express';
import { bootstrapApp, teardownDb, AUTH } from './helpers';
import { getDb } from '../../src/db/sqlite';
import { signingTasksService } from '../../src/modules/signing-tasks/signing-tasks.service';

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
