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
import { utxoLockService } from '../../src/shared/utxo-lock/utxo-lock.service';
import { getDb } from '../../src/db/sqlite';

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
    expect(d).toHaveProperty('current_total_raw');
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
    expect(res.body.data.threshold_raw).toBe('500000');
  });

  it('current_total_raw is "0" when no UTXOs exist', async () => {
    const { auth } = await createTenantWithKey();
    const res = await request(app).get('/v1/sweeps/summary').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.current_total_raw).toBe('0');
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

async function makeSweep() {
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

async function makeSigningTask(sweepId: string, signerId: string | null = null) {
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
  it('linkSigningTask sets signing_task_id on sweep', async () => {
    const sweep = await makeSweep();
    expect(sweep.signing_task_id).toBeNull();

    const task = await makeSigningTask(sweep.id);
    await sweepsService.linkSigningTask(sweep.id, task.id);

    const updated = await sweepsService.getByIdInternal(sweep.id);
    expect(updated.signing_task_id).toBe(task.id);
  });

  it('GET /v1/sweeps/:sweepId returns signing_task_id', async () => {
    const sweep = await makeSweep();
    const task = await makeSigningTask(sweep.id);
    await sweepsService.linkSigningTask(sweep.id, task.id);

    const res = await request(app).get(`/v1/sweeps/${sweep.id}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.signing_task_id).toBe(task.id);
  });
});

describe('Sweep — signing task visible to signer', () => {
  it('listAvailableForSigner includes btc_sweep task', async () => {
    const sweep = await makeSweep();
    const task = await makeSigningTask(sweep.id);
    await sweepsService.linkSigningTask(sweep.id, task.id);

    const tasks = await signingTasksService.listAvailableForSigner(TEST_TENANT_ID, 'any-signer-id', 10);
    const found = tasks.find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found!.request_type).toBe('btc_sweep');
    expect(found!.sweep_id).toBe(sweep.id);
  });

  it('listAvailableForSigner returns sweep task with signer_id=null (open to any signer)', async () => {
    const sweep = await makeSweep();
    const task = await makeSigningTask(sweep.id, null);

    const tasks = await signingTasksService.listAvailableForSigner(TEST_TENANT_ID, 'signer_xyz', 10);
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
    const sweep = await makeSweep();
    await makeSigningTask(sweep.id, signerId);

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
    const sweep = await makeSweep();
    const task = await makeSigningTask(sweep.id, signerId);

    const res = await request(app)
      .post(`/v1/external-signers/${signerId}/tasks/${task.id}/claim`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('claimed');
  });
});

describe('Sweep — finalizeSweepFromSigningTask rejects wrong status', () => {
  it('throws ValidationError when sweep is not pending_signature', async () => {
    const sweep = await makeSweep();
    await sweepsService.updateStatus(sweep.id, 'broadcast', { txHash: 'txhash_fake' });

    await expect(
      sweepsService.finalizeSweepFromSigningTask(TEST_TENANT_ID, sweep.id, 'signedpsbt==')
    ).rejects.toThrow("expected 'pending_signature'");
  });
});

// ─── Summary — UTXO locking behaviour (UI bug regression) ────────────────────
//
// Before the fix: getSummary() always returned UTXOs from cached_utxos with
// is_spent=0 AND is_locked=0. Since SweepWorker never locked UTXOs, the
// summary showed full balance even after a sweep was pending/broadcast.
// After the fix: SweepWorker calls lockUtxosForSweep(), making UTXOs invisible
// to getSummary() immediately after sweep creation.

describe('GET /v1/sweeps/summary — UTXO locking behaviour', () => {
  const CHAIN = 'bitcoin';
  let depositWalletId: string;

  // Insert a UTXO for tenant_default customer_deposits wallet
  let utxoSeq = 0;
  function insertUtxo(txHash: string, vout = 0, amountSats = 100_000) {
    const db = getDb();
    const now = new Date().toISOString();
    const id = `utxo_gap2_${++utxoSeq}`;
    db.prepare(`
      INSERT OR IGNORE INTO cached_utxos
        (id, tenant_id, customer_id, wallet_id, wallet_role, chain_id,
         address, tx_hash, vout, amount_raw, confirmations, is_spent, is_locked, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'customer_deposits', ?, ?, ?, ?, ?, 6, 0, 0, ?, ?)
    `).run(id, TEST_TENANT_ID, depositWalletId, CHAIN, uniqueAddr(), txHash, vout, String(amountSats), now, now);
  }

  beforeAll(() => {
    const row = getDb().prepare(
      "SELECT id FROM wallets WHERE tenant_id = ? AND wallet_role = 'customer_deposits' LIMIT 1"
    ).get(TEST_TENANT_ID) as { id: string } | undefined;
    if (!row) throw new Error('seed missing customer_deposits wallet for tenant_default');
    depositWalletId = row.id;
  });

  afterEach(() => {
    getDb().prepare("DELETE FROM cached_utxos WHERE id LIKE 'utxo_gap2_%'").run();
    getDb().prepare("DELETE FROM utxo_locks WHERE reference_type = 'sweep' AND reference_id LIKE 'sweep_%'").run();
  });

  it('shows UTXOs before a sweep is created', async () => {
    insertUtxo('gap2_tx_01', 0, 175_000);
    insertUtxo('gap2_tx_02', 0, 100_000);

    const res = await request(app).get('/v1/sweeps/summary').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.total_utxos).toBe(2);
    expect(res.body.data.current_total_raw).toBe('275000');
    expect(res.body.data.addresses_with_balance).toBe(2);
  });

  it('returns 0 utxos/sats after lockUtxosForSweep — UI bug regression', async () => {
    insertUtxo('gap2_tx_03', 0, 175_000);
    insertUtxo('gap2_tx_04', 0, 100_000);

    const sweep = await sweepsService.create(TEST_TENANT_ID, {
      chainId: CHAIN, assetId: 'bitcoin:BTC',
      fromAddresses: [uniqueAddr()],
      toAddress: uniqueAddr(),
      amountRaw: '275000', feeRaw: '550',
      psbt: Buffer.from('fake').toString('base64'),
    });
    await utxoLockService.lockUtxosForSweep(TEST_TENANT_ID, sweep.id, CHAIN, [
      { tx_hash: 'gap2_tx_03', vout: 0, amount_raw: '175000' },
      { tx_hash: 'gap2_tx_04', vout: 0, amount_raw: '100000' },
    ]);

    const res = await request(app).get('/v1/sweeps/summary').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.total_utxos).toBe(0);
    expect(res.body.data.current_total_raw).toBe('0');
    expect(res.body.data.addresses_with_balance).toBe(0);
  });

  it('still returns 0 after sweep moves to broadcast status', async () => {
    insertUtxo('gap2_tx_05', 0, 175_000);

    const sweep = await sweepsService.create(TEST_TENANT_ID, {
      chainId: CHAIN, assetId: 'bitcoin:BTC',
      fromAddresses: [uniqueAddr()], toAddress: uniqueAddr(),
      amountRaw: '175000', feeRaw: '550',
      psbt: Buffer.from('fake').toString('base64'),
    });
    await utxoLockService.lockUtxosForSweep(TEST_TENANT_ID, sweep.id, CHAIN, [
      { tx_hash: 'gap2_tx_05', vout: 0, amount_raw: '175000' },
    ]);
    await sweepsService.updateStatus(sweep.id, 'broadcast', { txHash: 'deadbeef_gap2' });

    const res = await request(app).get('/v1/sweeps/summary').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.total_utxos).toBe(0);
    expect(res.body.data.current_total_raw).toBe('0');
  });

  it('restores UTXO count after releaseLocksForSweep (sweep failed)', async () => {
    insertUtxo('gap2_tx_06', 0, 175_000);

    const sweep = await sweepsService.create(TEST_TENANT_ID, {
      chainId: CHAIN, assetId: 'bitcoin:BTC',
      fromAddresses: [uniqueAddr()], toAddress: uniqueAddr(),
      amountRaw: '175000', feeRaw: '550',
      psbt: Buffer.from('fake').toString('base64'),
    });
    await utxoLockService.lockUtxosForSweep(TEST_TENANT_ID, sweep.id, CHAIN, [
      { tx_hash: 'gap2_tx_06', vout: 0, amount_raw: '175000' },
    ]);
    await sweepsService.updateStatus(sweep.id, 'failed', { error: 'test' });
    await utxoLockService.releaseLocksForSweep(TEST_TENANT_ID, sweep.id);

    const res = await request(app).get('/v1/sweeps/summary').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.total_utxos).toBe(1);
    expect(res.body.data.current_total_raw).toBe('175000');
  });
});

describe('Sweep — submitSignedTask auto-finalize passes input.signedPayload (Bug 3 regression)', () => {
  // Regression: task.signed_payload is null before the UPDATE happens.
  // submitSignedTask must use input.signedPayload, not task.signed_payload,
  // otherwise finalizeSweepFromSigningTask receives null and Bitcoin Core
  // throws "JSON value of type null is not of expected type string".
  it('calls finalizeSweepFromSigningTask with input.signedPayload, not null', async () => {
    const sweep = await makeSweep();
    const task = await makeSigningTask(sweep.id, null);
    await sweepsService.linkSigningTask(sweep.id, task.id);

    // Claim the task (required before submit)
    await signingTasksService.claimTask(TEST_TENANT_ID, task.id, 'test-signer-regression');

    // Spy on finalizeSweepFromSigningTask to capture the payload it receives
    const spy = jest
      .spyOn(sweepsService, 'finalizeSweepFromSigningTask')
      .mockResolvedValue(sweep as any); // avoid Bitcoin Core call in tests

    const signedPayload = Buffer.from('fake-signed-psbt-regression').toString('base64');
    const crypto = require('crypto');
    const signedHash = crypto.createHash('sha256').update(signedPayload).digest('hex');

    await signingTasksService.submitSignedTask(TEST_TENANT_ID, task.id, 'test-signer-regression', {
      signedPayload,
      signedPayloadHash: signedHash,
      signerFingerprint: 'btc:test:regression',
    });

    // Wait for setImmediate (auto-finalize fires asynchronously)
    await new Promise(resolve => setImmediate(resolve));

    expect(spy).toHaveBeenCalledTimes(1);
    // Critical assertion: must receive the real signed payload, NOT null
    expect(spy).toHaveBeenCalledWith(TEST_TENANT_ID, sweep.id, signedPayload);
    const receivedPayload = spy.mock.calls[0]![2];
    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload).toBe(signedPayload);

    spy.mockRestore();
  });
});
