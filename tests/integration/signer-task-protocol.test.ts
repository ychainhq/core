/**
 * Unit tests — signer task field mapping (Bug 2 regression)
 *
 * The external signer protocol uses camelCase field names (`chain`, `payloadFormat`)
 * while the DB schema uses snake_case (`chain_id`, `payload_format`).
 * The GET /external-signers/:signerId/tasks and POST .../claim endpoints must
 * transform the DB row before sending it to the signer daemon.
 *
 * These tests verify the mapping logic directly via the integration layer,
 * catching any future rename or missing field.
 */

import request from 'supertest';
import express from 'express';
import { bootstrapApp, teardownDb, AUTH } from '../integration/helpers';
import { getDb } from '../../src/db/sqlite';
import { signingTasksService } from '../../src/modules/signing-tasks/signing-tasks.service';

let app: express.Application;
const TEST_TENANT_ID = 'tenant_default';

beforeAll(() => {
  app = bootstrapApp();
});

afterAll(() => teardownDb());

function enrollAndActivateSigner(signerName: string, fingerprint: string) {
  return request(app)
    .post('/v1/external-signers/enroll')
    .set(AUTH)
    .send({
      name: signerName,
      edition: 'community',
      publicKey: `ed25519:${fingerprint}`,
      signerFingerprint: fingerprint,
      capabilities: {
        chains: ['bitcoin'],
        assets: ['bitcoin:BTC'],
        formats: ['btc_psbt'],
      },
    });
}

async function activateSigner(signerId: string) {
  await request(app)
    .post(`/v1/external-signers/${signerId}/heartbeat`)
    .set(AUTH)
    .send({
      status: 'healthy',
      version: '1.0.0',
      capabilities: { chains: ['bitcoin'], assets: ['bitcoin:BTC'], formats: ['btc_psbt'] },
      time: new Date().toISOString(),
    });
}

// ─── Bug 2: GET /tasks returns camelCase protocol fields ───────────────────

describe('Signer task protocol — GET /tasks field mapping', () => {
  let signerId: string;
  let taskId: string;

  beforeAll(async () => {
    const enrollRes = await enrollAndActivateSigner('Mapper Test Signer', 'fp:mapper:001');
    signerId = enrollRes.body.data.id;
    await activateSigner(signerId);

    const task = signingTasksService.create({
      tenantId: TEST_TENANT_ID,
      signerId,
      requestType: 'btc_withdrawal_batch',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      withdrawalBatchId: undefined,
      amountRaw: '200000',
      feeRaw: '500',
      feeRateSatVb: '5',
      outputsCount: 2,
      payloadFormat: 'btc_psbt',
      unsignedPayload: Buffer.from('psbt-payload-mapper-test').toString('base64'),
      decisionMode: 'auto',
      decisionReason: 'auto_limit',
    });
    taskId = task.id;
  });

  test('items array is present in response', async () => {
    const res = await request(app)
      .get(`/v1/external-signers/${signerId}/tasks`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  test('task has camelCase `chain` field (not `chain_id`)', async () => {
    const res = await request(app)
      .get(`/v1/external-signers/${signerId}/tasks`)
      .set(AUTH);

    const task = res.body.items.find((t: any) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task.chain).toBe('bitcoin');
    expect(task.chain_id).toBeUndefined();
  });

  test('task has camelCase `payloadFormat` field (not `payload_format`)', async () => {
    const res = await request(app)
      .get(`/v1/external-signers/${signerId}/tasks`)
      .set(AUTH);

    const task = res.body.items.find((t: any) => t.id === taskId);
    expect(task.payloadFormat).toBe('btc_psbt');
    expect(task.payload_format).toBeUndefined();
  });

  test('task has all required camelCase protocol fields', async () => {
    const res = await request(app)
      .get(`/v1/external-signers/${signerId}/tasks`)
      .set(AUTH);

    const task = res.body.items.find((t: any) => t.id === taskId);
    expect(task).toMatchObject({
      id: taskId,
      tenantId: TEST_TENANT_ID,
      signerId,
      requestType: 'btc_withdrawal_batch',
      chain: 'bitcoin',
      assetId: 'bitcoin:BTC',
      payloadFormat: 'btc_psbt',
      amountRaw: '200000',
      feeRaw: '500',
      decisionMode: 'auto',
      status: 'available',
    });
  });

  test('task has no snake_case DB fields exposed to signer', async () => {
    const res = await request(app)
      .get(`/v1/external-signers/${signerId}/tasks`)
      .set(AUTH);

    const task = res.body.items.find((t: any) => t.id === taskId);
    const snakeCaseFields = [
      'tenant_id', 'signer_id', 'request_type', 'chain_id', 'asset_id',
      'payload_format', 'unsigned_payload', 'unsigned_payload_hash',
      'decision_mode', 'retry_count', 'created_at', 'updated_at',
    ];
    for (const field of snakeCaseFields) {
      expect(task[field]).toBeUndefined();
    }
  });
});

// ─── Bug 2: POST /claim returns camelCase protocol fields ──────────────────

describe('Signer task protocol — POST /claim field mapping', () => {
  let signerId: string;
  let taskId: string;

  beforeAll(async () => {
    const enrollRes = await enrollAndActivateSigner('Claim Mapper Signer', 'fp:claim:mapper');
    signerId = enrollRes.body.data.id;
    await activateSigner(signerId);

    const task = signingTasksService.create({
      tenantId: TEST_TENANT_ID,
      signerId,
      requestType: 'btc_withdrawal_batch',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      withdrawalBatchId: undefined,
      amountRaw: '150000',
      feeRaw: '300',
      feeRateSatVb: '3',
      outputsCount: 1,
      payloadFormat: 'btc_psbt',
      unsignedPayload: Buffer.from('psbt-claim-test').toString('base64'),
      decisionMode: 'auto',
      decisionReason: 'auto_limit',
    });
    taskId = task.id;
  });

  test('POST /claim returns camelCase `chain` and `payloadFormat`', async () => {
    const res = await request(app)
      .post(`/v1/external-signers/${signerId}/tasks/${taskId}/claim`)
      .set(AUTH)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.chain).toBe('bitcoin');
    expect(res.body.data.chain_id).toBeUndefined();
    expect(res.body.data.payloadFormat).toBe('btc_psbt');
    expect(res.body.data.payload_format).toBeUndefined();
  });

  test('POST /claim returns full protocol task shape', async () => {
    const res = await request(app)
      .post(`/v1/external-signers/${signerId}/tasks/${taskId}/claim`)
      .set(AUTH)
      .send({});

    expect(res.body.data).toMatchObject({
      id: taskId,
      chain: 'bitcoin',
      payloadFormat: 'btc_psbt',
      status: 'claimed',
      decisionMode: 'auto',
    });
  });
});
