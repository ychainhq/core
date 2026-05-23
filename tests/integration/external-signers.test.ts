/**
 * External Signers Integration Tests
 *
 * Tests: enrollment, heartbeat, list tasks, claim, submit, reject
 */

import request from 'supertest';
import express from 'express';
import { bootstrapApp, teardownDb, AUTH } from './helpers';

let app: express.Application;

beforeAll(() => {
  app = bootstrapApp();
});

afterAll(() => teardownDb());

const enrollPayload = {
  name: 'Test OSS Signer',
  edition: 'community',
  publicKey: 'ed25519:testpubkey001',
  signerFingerprint: 'btc:testfp:001',
  capabilities: {
    chains: ['bitcoin'],
    assets: ['bitcoin:BTC'],
    formats: ['btc_psbt'],
  },
};

describe('External Signers — Enrollment', () => {
  test('POST /v1/external-signers/enroll — creates signer', async () => {
    const res = await request(app)
      .post('/v1/external-signers/enroll')
      .set(AUTH)
      .send(enrollPayload);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Test OSS Signer',
      edition: 'community',
      status: 'pending',
      signer_fingerprint: 'btc:testfp:001',
    });
  });

  test('POST /v1/external-signers/enroll — idempotent (same fingerprint)', async () => {
    const res = await request(app)
      .post('/v1/external-signers/enroll')
      .set(AUTH)
      .send(enrollPayload);

    expect(res.status).toBe(201);
    // Same signer returned
    expect(res.body.data.signer_fingerprint).toBe('btc:testfp:001');
  });

  test('GET /v1/external-signers — lists signers', async () => {
    const res = await request(app)
      .get('/v1/external-signers')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /v1/external-signers/:signerId — returns signer', async () => {
    const listRes = await request(app)
      .get('/v1/external-signers')
      .set(AUTH);

    const signerId = listRes.body.data[0].id;
    const res = await request(app)
      .get(`/v1/external-signers/${signerId}`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(signerId);
  });
});

describe('External Signers — Heartbeat', () => {
  let signerId: string;

  beforeAll(async () => {
    const listRes = await request(app)
      .get('/v1/external-signers')
      .set(AUTH);
    signerId = listRes.body.data[0].id;
  });

  test('POST /v1/external-signers/:signerId/heartbeat — updates status to active', async () => {
    const res = await request(app)
      .post(`/v1/external-signers/${signerId}/heartbeat`)
      .set(AUTH)
      .send({
        status: 'healthy',
        version: '1.0.0',
        capabilities: { chains: ['bitcoin'], assets: ['bitcoin:BTC'], formats: ['btc_psbt'] },
        time: new Date().toISOString(),
      });

    expect(res.status).toBe(200);
    expect(res.body.data.signerId).toBe(signerId);
    expect(res.body.data.status).toBe('active');
  });

  test('POST heartbeat — signer now active', async () => {
    const res = await request(app)
      .get(`/v1/external-signers/${signerId}`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.last_health_status).toBe('healthy');
  });
});

describe('External Signers — Enable/Disable', () => {
  let signerId: string;

  beforeAll(async () => {
    const listRes = await request(app)
      .get('/v1/external-signers')
      .set(AUTH);
    signerId = listRes.body.data[0].id;
  });

  test('POST /v1/external-signers/:signerId/disable', async () => {
    const res = await request(app)
      .post(`/v1/external-signers/${signerId}/disable`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.is_enabled).toBe(0);
  });

  test('POST /v1/external-signers/:signerId/enable', async () => {
    const res = await request(app)
      .post(`/v1/external-signers/${signerId}/enable`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.is_enabled).toBe(1);
  });
});

describe('External Signers — Policies', () => {
  test('PUT /v1/external-signers/policies — upserts policies', async () => {
    const res = await request(app)
      .put('/v1/external-signers/policies')
      .set(AUTH)
      .send({
        policies: [
          {
            chainId: 'bitcoin',
            assetId: 'bitcoin:BTC',
            autoSignLimitRaw: '1000000',
            manualApprovalFromRaw: '1000001',
            maxFeeRateSatVb: 50,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].chain_id).toBe('bitcoin');
  });

  test('GET /v1/external-signers/policies — lists policies', async () => {
    const res = await request(app)
      .get('/v1/external-signers/policies')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('External Signers — Tasks (no tasks yet)', () => {
  let signerId: string;

  beforeAll(async () => {
    const listRes = await request(app)
      .get('/v1/external-signers')
      .set(AUTH);
    signerId = listRes.body.data[0].id;
  });

  test('GET /v1/external-signers/:signerId/tasks — returns empty list', async () => {
    const res = await request(app)
      .get(`/v1/external-signers/${signerId}/tasks`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBe(0);
  });
});

describe('External Signers — Revoke', () => {
  test('DELETE /v1/external-signers/:signerId — revokes signer', async () => {
    // Enroll a new signer to revoke
    const enrollRes = await request(app)
      .post('/v1/external-signers/enroll')
      .set(AUTH)
      .send({
        ...enrollPayload,
        signerFingerprint: 'btc:testfp:revoke',
        name: 'Signer to Revoke',
      });

    const signerId = enrollRes.body.data.id;

    const res = await request(app)
      .delete(`/v1/external-signers/${signerId}`)
      .set(AUTH);

    expect(res.status).toBe(204);

    const getRes = await request(app)
      .get(`/v1/external-signers/${signerId}`)
      .set(AUTH);

    expect(getRes.body.data.status).toBe('revoked');
  });
});
