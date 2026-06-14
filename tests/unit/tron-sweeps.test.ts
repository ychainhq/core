/**
 * Unit / integration tests — TRON chain routing in sweeps.service
 *
 * Covers:
 * - finalizeSweepFromSigningTask() TRON: calls sendRawTransaction(signedPayload) ONLY (no finalizePsbt)
 * - finalizeSweepFromSigningTask() BTC: calls finalizePsbt → sendRawTransaction(hex) (regression guard)
 * - submitSigned() TRON: same direct broadcast routing
 * - submitSigned() BTC: psbt finalization + broadcast (regression guard)
 * - status updated to 'broadcast' after successful broadcast
 * - tx_hash stored on the sweep record
 *
 * Uses bootstrapApp() for real SQLite (sweepsService needs DB).
 * adapterRegistry.get() is spied on to prevent real RPC calls.
 */
import { bootstrapApp, teardownDb, uniqueAddr, AUTH } from '../integration/helpers';
import request from 'supertest';
import { sweepsService } from '../../src/modules/sweeps/sweeps.service';
import { signingTasksService } from '../../src/modules/signing-tasks/signing-tasks.service';
import { adapterRegistry } from '../../src/chain-adapters/registry';

jest.setTimeout(30000);

const app = bootstrapApp();
afterAll(() => teardownDb());

const TEST_TENANT_ID = 'tenant_default';

// ── Mock adapter factory ──────────────────────────────────────────────────────

function makeMockAdapter(txHash: string) {
  return {
    sendRawTransaction: jest.fn().mockResolvedValue(txHash),
    finalizePsbt: jest.fn().mockResolvedValue({ complete: true, hex: 'finalized_hex_' + txHash }),
    isValidAddress: jest.fn().mockReturnValue(true),
    validateAddress: jest.fn().mockResolvedValue({ isValid: true }),
    estimateFeeRateSatVb: jest.fn().mockResolvedValue(5),
    buildUnsignedWithdrawalTx: jest.fn(),
  };
}

// ── Sweep / task factory ──────────────────────────────────────────────────────

async function makeTronSweep() {
  return sweepsService.create(TEST_TENANT_ID, {
    chainId: 'tron',
    assetId: 'tron:USDT',
    fromAddresses: ['TGkJfGg4oU9Y37r5ZBXnUMtLFt7Eaz8HGN'],
    toAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    amountRaw: '10000000',
    feeRaw: '40000000',
    psbt: 'deadbeef1234', // raw_data_hex for TRON
  });
}

async function makeBtcSweep() {
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

async function makeSigningTask(sweepId: string, chainId: string, payloadFormat: string, requestType: string) {
  return signingTasksService.create({
    tenantId: TEST_TENANT_ID,
    signerId: null,
    requestType,
    chainId,
    assetId: chainId === 'tron' ? 'tron:USDT' : 'bitcoin:BTC',
    sweepId,
    amountRaw: '10000000',
    feeRaw: '40000000',
    feeRateSatVb: '0',
    payloadFormat,
    unsignedPayload: 'raw_data_hex_here',
    decisionMode: 'auto',
  });
}

// ── finalizeSweepFromSigningTask — TRON ───────────────────────────────────────

describe('finalizeSweepFromSigningTask() — TRON chain', () => {
  let registryGetSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('calls sendRawTransaction(signedPayload) WITHOUT calling finalizePsbt', async () => {
    const mockAdapter = makeMockAdapter('tron_tx_hash_001');
    registryGetSpy = jest.spyOn(adapterRegistry, 'get').mockReturnValue(mockAdapter as any);

    const sweep = await makeTronSweep();
    const task = await makeSigningTask(sweep.id, 'tron', 'tron_raw_tx', 'tron_sweep');
    await sweepsService.linkSigningTask(sweep.id, task.id);

    const signed = 'signed_tron_raw_tx_payload_hex';
    await sweepsService.finalizeSweepFromSigningTask(TEST_TENANT_ID, sweep.id, signed);

    expect(mockAdapter.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockAdapter.sendRawTransaction).toHaveBeenCalledWith(signed);
    expect(mockAdapter.finalizePsbt).not.toHaveBeenCalled();
  });

  it('uses adapterRegistry.get(sweep.chain_id) — "tron" in this case', async () => {
    const mockAdapter = makeMockAdapter('tron_tx_hash_002');
    registryGetSpy = jest.spyOn(adapterRegistry, 'get').mockReturnValue(mockAdapter as any);

    const sweep = await makeTronSweep();
    const task = await makeSigningTask(sweep.id, 'tron', 'tron_raw_tx', 'tron_sweep');
    await sweepsService.linkSigningTask(sweep.id, task.id);

    await sweepsService.finalizeSweepFromSigningTask(TEST_TENANT_ID, sweep.id, 'signed_payload');

    expect(registryGetSpy).toHaveBeenCalledWith('tron');
  });

  it('updates sweep status to "broadcast" and stores tx_hash', async () => {
    const txHash = 'tron_tx_hash_003_' + Date.now();
    const mockAdapter = makeMockAdapter(txHash);
    jest.spyOn(adapterRegistry, 'get').mockReturnValue(mockAdapter as any);

    const sweep = await makeTronSweep();
    const task = await makeSigningTask(sweep.id, 'tron', 'tron_raw_tx', 'tron_sweep');
    await sweepsService.linkSigningTask(sweep.id, task.id);

    await sweepsService.finalizeSweepFromSigningTask(TEST_TENANT_ID, sweep.id, 'any_signed_payload');

    const updated = await sweepsService.getByIdInternal(sweep.id);
    expect(updated.status).toBe('broadcast');
    expect(updated.tx_hash).toBe(txHash);
  });

  it('throws when sweep is not pending_signature', async () => {
    const mockAdapter = makeMockAdapter('unused');
    jest.spyOn(adapterRegistry, 'get').mockReturnValue(mockAdapter as any);

    const sweep = await makeTronSweep();
    await sweepsService.updateStatus(sweep.id, 'broadcast', { txHash: 'already_done' });

    await expect(
      sweepsService.finalizeSweepFromSigningTask(TEST_TENANT_ID, sweep.id, 'signed_payload')
    ).rejects.toThrow("expected 'pending_signature'");

    expect(mockAdapter.sendRawTransaction).not.toHaveBeenCalled();
  });
});

// ── finalizeSweepFromSigningTask — BTC (regression guard) ────────────────────

describe('finalizeSweepFromSigningTask() — BTC chain (regression guard)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('calls finalizePsbt THEN sendRawTransaction(hex) — NOT sendRawTransaction(psbt)', async () => {
    const mockAdapter = makeMockAdapter('btc_tx_hash_001');
    jest.spyOn(adapterRegistry, 'get').mockReturnValue(mockAdapter as any);

    const sweep = await makeBtcSweep();
    const task = await makeSigningTask(sweep.id, 'bitcoin', 'btc_psbt', 'btc_sweep');
    await sweepsService.linkSigningTask(sweep.id, task.id);

    const signedPsbt = Buffer.from('signed-psbt-data').toString('base64');
    await sweepsService.finalizeSweepFromSigningTask(TEST_TENANT_ID, sweep.id, signedPsbt);

    expect(mockAdapter.finalizePsbt).toHaveBeenCalledTimes(1);
    expect(mockAdapter.finalizePsbt).toHaveBeenCalledWith(signedPsbt);
    // sendRawTransaction must be called with the finalized hex, not with signedPsbt
    expect(mockAdapter.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockAdapter.sendRawTransaction).toHaveBeenCalledWith(
      'finalized_hex_btc_tx_hash_001'
    );
  });
});

// ── submitSigned() — TRON ────────────────────────────────────────────────────

describe('submitSigned() — TRON chain', () => {
  afterEach(() => jest.restoreAllMocks());

  it('broadcasts signedPayload directly without calling finalizePsbt', async () => {
    const txHash = 'tron_submit_tx_' + Date.now();
    const mockAdapter = makeMockAdapter(txHash);
    jest.spyOn(adapterRegistry, 'get').mockReturnValue(mockAdapter as any);

    const sweep = await makeTronSweep();
    const signedPayload = 'tron_signed_raw_tx_hex_payload';

    const result = await sweepsService.submitSigned(TEST_TENANT_ID, sweep.id, signedPayload);

    expect(mockAdapter.sendRawTransaction).toHaveBeenCalledWith(signedPayload);
    expect(mockAdapter.finalizePsbt).not.toHaveBeenCalled();
    expect(result.status).toBe('broadcast');
    expect(result.tx_hash).toBe(txHash);
  });

  it('POST /v1/sweeps/:id/submit-signed routes TRON sweep through correct adapter', async () => {
    const txHash = 'tron_http_submit_' + Date.now();
    const mockAdapter = makeMockAdapter(txHash);
    jest.spyOn(adapterRegistry, 'get').mockReturnValue(mockAdapter as any);

    const sweep = await makeTronSweep();

    const res = await request(app)
      .post(`/v1/sweeps/${sweep.id}/submit-signed`)
      .set(AUTH)
      .send({ signedPsbt: 'tron_signed_payload' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('broadcast');
    expect(res.body.data.tx_hash).toBe(txHash);
    expect(mockAdapter.finalizePsbt).not.toHaveBeenCalled();
  });
});

// ── submitSigned() — BTC (regression guard) ──────────────────────────────────

describe('submitSigned() — BTC chain (regression guard)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('calls finalizePsbt THEN sendRawTransaction(hex) for BTC sweep', async () => {
    const mockAdapter = makeMockAdapter('btc_submit_tx_001');
    jest.spyOn(adapterRegistry, 'get').mockReturnValue(mockAdapter as any);

    const sweep = await makeBtcSweep();
    const signedPsbt = Buffer.from('signed-btc-psbt').toString('base64');

    const result = await sweepsService.submitSigned(TEST_TENANT_ID, sweep.id, signedPsbt);

    expect(mockAdapter.finalizePsbt).toHaveBeenCalledWith(signedPsbt);
    expect(mockAdapter.sendRawTransaction).toHaveBeenCalledWith('finalized_hex_btc_submit_tx_001');
    expect(result.status).toBe('broadcast');
  });
});
