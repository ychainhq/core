/**
 * Unit tests — toSignerTask mapper (Bug 2 regression)
 *
 * Verifies that the DB row (snake_case) is correctly mapped to the
 * external-signer-protocol's camelCase SigningTask shape.
 *
 * Key regressions:
 *   - chain_id  → chain      (signer uses `chain`, not `chainId`)
 *   - payload_format → payloadFormat
 *   - fee_rate_sat_vb is converted to Number (protocol field is numeric)
 */

import { toSignerTask } from '../../src/modules/external-signers/external-signers.router';

const SAMPLE_DB_ROW = {
  id: 'sigtsk_abc123',
  tenant_id: 'tenant_default',
  signer_id: 'sgn_001',
  request_type: 'btc_withdrawal_batch',
  chain_id: 'bitcoin',
  asset_id: 'bitcoin:BTC',
  withdrawal_batch_id: 'wdb_xyz',
  sweep_id: null,
  amount_raw: '500000',
  fee_raw: '1000',
  fee_rate_sat_vb: '10',
  outputs_count: 3,
  payload_format: 'btc_psbt',
  unsigned_payload: 'cHNidA==',
  unsigned_payload_hash: 'abc123hash',
  status: 'available',
  decision_mode: 'auto',
  decision_reason: 'auto_limit',
  claimed_by_signer_id: null,
  claimed_at: null,
  expires_at: '2026-06-01T00:00:00Z',
  signed_payload: null,
  signed_payload_hash: null,
  signer_fingerprint: null,
  signer_response_signature: null,
  signed_at: null,
  rejection_reason_code: null,
  rejection_reason_message: null,
  rejected_at: null,
  tx_hash: null,
  failure_code: null,
  failure_message: null,
  retry_count: 0,
  created_at: '2026-05-27T00:00:00Z',
  updated_at: '2026-05-27T00:00:00Z',
};

describe('toSignerTask — critical field renames', () => {
  test('maps chain_id → chain', () => {
    const result = toSignerTask(SAMPLE_DB_ROW) as any;
    expect(result.chain).toBe('bitcoin');
    expect(result.chain_id).toBeUndefined();
  });

  test('maps payload_format → payloadFormat', () => {
    const result = toSignerTask(SAMPLE_DB_ROW) as any;
    expect(result.payloadFormat).toBe('btc_psbt');
    expect(result.payload_format).toBeUndefined();
  });

  test('converts fee_rate_sat_vb string to Number', () => {
    const result = toSignerTask(SAMPLE_DB_ROW) as any;
    expect(result.feeRateSatVb).toBe(10);
    expect(typeof result.feeRateSatVb).toBe('number');
  });

  test('returns null for null fee_rate_sat_vb', () => {
    const result = toSignerTask({ ...SAMPLE_DB_ROW, fee_rate_sat_vb: null }) as any;
    expect(result.feeRateSatVb).toBeNull();
  });
});

describe('toSignerTask — all snake_case fields remapped', () => {
  let result: any;

  beforeAll(() => {
    result = toSignerTask(SAMPLE_DB_ROW);
  });

  test('id is preserved', () => expect(result.id).toBe('sigtsk_abc123'));
  test('tenantId mapped from tenant_id', () => {
    expect(result.tenantId).toBe('tenant_default');
    expect(result.tenant_id).toBeUndefined();
  });
  test('signerId mapped from signer_id', () => {
    expect(result.signerId).toBe('sgn_001');
    expect(result.signer_id).toBeUndefined();
  });
  test('requestType mapped from request_type', () => {
    expect(result.requestType).toBe('btc_withdrawal_batch');
    expect(result.request_type).toBeUndefined();
  });
  test('assetId mapped from asset_id', () => {
    expect(result.assetId).toBe('bitcoin:BTC');
    expect(result.asset_id).toBeUndefined();
  });
  test('withdrawalBatchId mapped from withdrawal_batch_id', () => {
    expect(result.withdrawalBatchId).toBe('wdb_xyz');
    expect(result.withdrawal_batch_id).toBeUndefined();
  });
  test('amountRaw mapped from amount_raw', () => {
    expect(result.amountRaw).toBe('500000');
    expect(result.amount_raw).toBeUndefined();
  });
  test('feeRaw mapped from fee_raw', () => {
    expect(result.feeRaw).toBe('1000');
    expect(result.fee_raw).toBeUndefined();
  });
  test('outputsCount mapped from outputs_count', () => {
    expect(result.outputsCount).toBe(3);
    expect(result.outputs_count).toBeUndefined();
  });
  test('unsignedPayload mapped from unsigned_payload', () => {
    expect(result.unsignedPayload).toBe('cHNidA==');
    expect(result.unsigned_payload).toBeUndefined();
  });
  test('unsignedPayloadHash mapped from unsigned_payload_hash', () => {
    expect(result.unsignedPayloadHash).toBe('abc123hash');
    expect(result.unsigned_payload_hash).toBeUndefined();
  });
  test('decisionMode mapped from decision_mode', () => {
    expect(result.decisionMode).toBe('auto');
    expect(result.decision_mode).toBeUndefined();
  });
  test('decisionReason mapped from decision_reason', () => {
    expect(result.decisionReason).toBe('auto_limit');
    expect(result.decision_reason).toBeUndefined();
  });
  test('expiresAt mapped from expires_at', () => {
    expect(result.expiresAt).toBe('2026-06-01T00:00:00Z');
    expect(result.expires_at).toBeUndefined();
  });
  test('retryCount mapped from retry_count', () => {
    expect(result.retryCount).toBe(0);
    expect(result.retry_count).toBeUndefined();
  });
  test('createdAt mapped from created_at', () => {
    expect(result.createdAt).toBe('2026-05-27T00:00:00Z');
    expect(result.created_at).toBeUndefined();
  });
  test('updatedAt mapped from updated_at', () => {
    expect(result.updatedAt).toBe('2026-05-27T00:00:00Z');
    expect(result.updated_at).toBeUndefined();
  });
});

describe('toSignerTask — null/signed fields', () => {
  test('signedPayload stays null when not signed', () => {
    const result = toSignerTask(SAMPLE_DB_ROW) as any;
    expect(result.signedPayload).toBeNull();
    expect(result.signed_payload).toBeUndefined();
  });

  test('signerFingerprint propagated from signer_fingerprint', () => {
    const result = toSignerTask({
      ...SAMPLE_DB_ROW,
      signer_fingerprint: 'btc:fp:001',
    }) as any;
    expect(result.signerFingerprint).toBe('btc:fp:001');
    expect(result.signer_fingerprint).toBeUndefined();
  });

  test('rejectionReasonCode mapped from rejection_reason_code', () => {
    const result = toSignerTask({
      ...SAMPLE_DB_ROW,
      rejection_reason_code: 'signer_internal_error',
      rejection_reason_message: 'Unsupported format',
    }) as any;
    expect(result.rejectionReasonCode).toBe('signer_internal_error');
    expect(result.rejectionReasonMessage).toBe('Unsupported format');
    expect(result.rejection_reason_code).toBeUndefined();
    expect(result.rejection_reason_message).toBeUndefined();
  });
});
