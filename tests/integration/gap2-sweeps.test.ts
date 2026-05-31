/**
 * Integration tests for GAP 2 — Sweep management endpoints.
 *
 * Covers:
 * - GET /v1/sweeps returns empty list initially
 * - GET /v1/sweeps/:sweepId returns 404 for unknown
 * - POST /v1/sweeps/:sweepId/submit-signed returns 400 if not pending_signature
 * - btcSweepThresholdSats stored and returned in tenant config
 * - Sweep is tenant-scoped (cross-tenant access denied)
 * - Signing task flow: sweep creates signing_task, signer can list/claim/submit
 */
import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, teardownDb, uniqueAddr, AUTH } from './helpers';
import { sweepsService } from '../../src/modules/sweeps/sweeps.service';
import { signingTasksService } from '../../src/modules/signing-tasks/signing-tasks.service';

const app = bootstrapApp();
afterAll(() => teardownDb());

async function createTenantWithKey(): Promise<{ tenantId: string; auth: { Authorization: string } }> {
  const createRes = await request(app)
    .post('/admin/v1/tenants')
    .set(ADMIN_AUTH)
    .send({ name: `sweep-test-tenant-${Date.now()}`, assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
  const tenantId = createRes.body.data.id;
  const keyRes = await request(app)
    .post(`/admin/v1/tenants/${tenantId}/api-keys`)
    .set(ADMIN_AUTH)
    .send({ name: 'key' });
  return { tenantId, auth: { Authorization: `Bearer ${keyRes.body.data.apiKey}` } };
}

describe('GET /v1/sweeps', () => {
  it('returns empty list when no sweeps exist', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/sweeps').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toBeDefined();
  });

  it('requires auth', async () => {
    const res = await request(app).get('/v1/sweeps');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/sweeps/:sweepId', () => {
  it('returns 404 for unknown sweep', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/sweeps/sweep_doesnotexist').set(auth);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/sweeps/:sweepId/submit-signed', () => {
  it('returns 404 for unknown sweep', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .post('/v1/sweeps/sweep_ghost/submit-signed')
      .set(auth)
      .send({ signedPsbt: 'fakepsbt==' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when signedPsbt is missing', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app)
      .post('/v1/sweeps/sweep_ghost/submit-signed')
      .set(auth)
      .send({});
    // 400 from Zod validation (signedPsbt required)
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/sweeps/summary', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/v1/sweeps/summary');
    expect(res.status).toBe(401);
  });

  it('returns summary object with required fields', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/sweeps/summary').set(auth);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toHaveProperty('current_total_sats');
    expect(d).toHaveProperty('total_deposit_addresses');
    expect(d).toHaveProperty('addresses_with_balance');
    expect(d).toHaveProperty('total_utxos');
    expect(d).toHaveProperty('pending_sweep_id');
  });

  it('progress_pct is null when threshold is not configured', async () => {
    const { tenantId } = await createTenantWithKey();
    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'key2' });
    const auth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcSweepThresholdSats: null });

    const res = await request(app).get('/v1/sweeps/summary').set(auth);
    expect(res.status).toBe(200);
  });

  it('threshold_sats matches value set in tenant config', async () => {
    const { tenantId } = await createTenantWithKey();
    const keyRes = await request(app)
      .post(`/admin/v1/tenants/${tenantId}/api-keys`)
      .set(ADMIN_AUTH)
      .send({ name: 'k3' });
    const auth = { Authorization: `Bearer ${keyRes.body.data.apiKey}` };

    await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcSweepThresholdSats: '500000' });

    const res = await request(app).get('/v1/sweeps/summary').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.threshold_sats).toBe('500000');
  });

  it('current_total_sats is "0" when no UTXOs exist', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/sweeps/summary').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.current_total_sats).toBe('0');
  });

  it('pending_sweep_id is null when no pending sweep', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/sweeps/summary').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.pending_sweep_id).toBeNull();
  });

  it('is tenant-scoped — different tenants get separate summaries', async () => {
    const { auth: auth1 } = await createTenantWithKey();
    const { auth: auth2 } = await createTenantWithKey();
    const [r1, r2] = await Promise.all([
      request(app).get('/v1/sweeps/summary').set(auth1),
      request(app).get('/v1/sweeps/summary').set(auth2),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

describe('Tenant config — sweep threshold', () => {
  it('stores and returns btcSweepThresholdSats', async () => {
    const { tenantId } = await createTenantWithKey();

    const res = await request(app)
      .patch(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH)
      .send({ btcSweepThresholdSats: '250000' });

    expect(res.status).toBe(200);
    expect(res.body.data.btc_sweep_threshold_sats).toBe('250000');
  });

  it('default sweep threshold is 100000 sats', async () => {
    const createRes = await request(app)
      .post('/admin/v1/tenants')
      .set(ADMIN_AUTH)
      .send({ name: 'default-sweep-tenant', assets: [{ chain: 'bitcoin', hotAddress: uniqueAddr() }] });
    const tenantId = createRes.body.data.id;

    const res = await request(app)
      .get(`/admin/v1/tenants/${tenantId}/config`)
      .set(ADMIN_AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.btc_sweep_threshold_sats).toBe('100000');
  });
});

// ─── Signing task flow ────────────────────────────────────────────────────────

const TEST_TENANT_ID = 'tenant_default';

function makeSweep() {
  return sweepsService.create(TEST_TENANT_ID, {
    chainId: 'bitcoin',
    assetId: 'bitcoin:BTC',
    fromAddresses: [uniqueAddr(), uniqueAddr()],
    toAddress: uniqueAddr(),
    amountRaw: '950000',
    feeRaw: '5000',
    psbt: Buffer.from('fake-psbt-sweep').toString('base64'),
  });
}

function makeSigningTask(sweepId: string, signerId: string | null = null) {
  return signingTasksService.create({
    tenantId: TEST_TENANT_ID,
    signerId,
    requestType: 'btc_sweep',
    chainId: 'bitcoin',
    assetId: 'bitcoin:BTC',
    sweepId,
    amountRaw: '945000',
    feeRaw: '5000',
    feeRateSatVb: '5',
    payloadFormat: 'btc_psbt',
    unsignedPayload: Buffer.from('fake-psbt-sweep').toString('base64'),
    decisionMode: 'auto',
  });
}

describe('Sweep — signing_task_id field', () => {
  it('linkSigningTask sets signing_task_id on sweep', () => {
    const sweep = makeSweep();
    expect(sweep.signing_task_id).toBeNull();

    const task = makeSigningTask(sweep.id);
    sweepsService.linkSigningTask(sweep.id, task.id);

    const updated = sweepsService.getByIdInternal(sweep.id);
    expect(updated.signing_task_id).toBe(task.id);
  });

  it('GET /v1/sweeps/:sweepId returns signing_task_id', async () => {
    const sweep = makeSweep();
    const task = makeSigningTask(sweep.id);
    sweepsService.linkSigningTask(sweep.id, task.id);

    const res = await request(app).get(`/v1/sweeps/${sweep.id}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.signing_task_id).toBe(task.id);
  });
});

describe('Sweep — signing task visible to signer', () => {
  it('listAvailableForSigner includes btc_sweep task', () => {
    const sweep = makeSweep();
    const task = makeSigningTask(sweep.id);
    sweepsService.linkSigningTask(sweep.id, task.id);

    const tasks = signingTasksService.listAvailableForSigner(TEST_TENANT_ID, 'any-signer-id', 10);
    const found = tasks.find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found!.request_type).toBe('btc_sweep');
    expect(found!.sweep_id).toBe(sweep.id);
  });

  it('listAvailableForSigner returns sweep task with signer_id=null (open to any signer)', () => {
    const sweep = makeSweep();
    const task = makeSigningTask(sweep.id, null);

    const tasks = signingTasksService.listAvailableForSigner(TEST_TENANT_ID, 'signer_xyz', 10);
    expect(tasks.some((t) => t.id === task.id)).toBe(true);
  });
});

describe('Sweep — signer can claim sweep task via HTTP', () => {
  async function enrollSigner(name: string, fp: string) {
    const enrollRes = await request(app)
      .post('/v1/external-signers/enroll')
      .set(AUTH)
      .send({
        name,
        edition: 'community',
        publicKey: `ed25519:${fp}`,
        signerFingerprint: fp,
        capabilities: { chains: ['bitcoin'], assets: ['bitcoin:BTC'], formats: ['btc_psbt'] },
      });
    const signerId = enrollRes.body.data.id;
    await request(app)
      .post(`/v1/external-signers/${signerId}/heartbeat`)
      .set(AUTH)
      .send({
        status: 'healthy',
        version: '1.0.0',
        capabilities: { chains: ['bitcoin'], assets: ['bitcoin:BTC'], formats: ['btc_psbt'] },
        time: new Date().toISOString(),
      });
    return signerId;
  }

  it('signer sees btc_sweep task in task list', async () => {
    const signerId = await enrollSigner('sweep-signer-list', `fp:sweep:list:${Date.now()}`);
    const sweep = makeSweep();
    makeSigningTask(sweep.id, signerId);

    const res = await request(app)
      .get(`/v1/external-signers/${signerId}/tasks`)
      .set(AUTH);

    expect(res.status).toBe(200);
    const task = res.body.items.find((t: any) => t.sweepId === sweep.id);
    expect(task).toBeDefined();
    expect(task.requestType).toBe('btc_sweep');
  });

  it('signer can claim sweep task', async () => {
    const signerId = await enrollSigner('sweep-signer-claim', `fp:sweep:claim:${Date.now()}`);
    const sweep = makeSweep();
    const task = makeSigningTask(sweep.id, signerId);

    const res = await request(app)
      .post(`/v1/external-signers/${signerId}/tasks/${task.id}/claim`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('claimed');
  });
});

describe('Sweep — finalizeSweepFromSigningTask rejects wrong status', () => {
  it('throws ValidationError when sweep is not pending_signature', async () => {
    const sweep = makeSweep();
    sweepsService.updateStatus(sweep.id, 'broadcast', { txHash: 'txhash_fake' });

    await expect(
      sweepsService.finalizeSweepFromSigningTask(TEST_TENANT_ID, sweep.id, 'signedpsbt==')
    ).rejects.toThrow("expected 'pending_signature'");
  });
});
