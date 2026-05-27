/**
 * External Signers Router
 *
 * Management API (tenant UI):
 *   POST   /v1/external-signers/enroll
 *   GET    /v1/external-signers
 *   GET    /v1/external-signers/:signerId
 *   PATCH  /v1/external-signers/:signerId
 *   POST   /v1/external-signers/:signerId/enable
 *   POST   /v1/external-signers/:signerId/disable
 *   DELETE /v1/external-signers/:signerId
 *   GET    /v1/external-signers/policies
 *   PUT    /v1/external-signers/policies
 *
 * Signer protocol API (called by signer daemons):
 *   POST   /v1/external-signers/:signerId/heartbeat
 *   GET    /v1/external-signers/:signerId/tasks
 *   POST   /v1/external-signers/:signerId/tasks/:taskId/claim
 *   POST   /v1/external-signers/:signerId/tasks/:taskId/submit
 *   POST   /v1/external-signers/:signerId/tasks/:taskId/reject
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { externalSignersService } from './external-signers.service';
import { signerPolicyService } from './signer-policy.service';
import { signingTasksService } from '../signing-tasks/signing-tasks.service';
import { resolvePermission } from '../../shared/actor-auth/context';
import { ApiError } from '../../shared/errors/index';

export const externalSignersRouter = Router();

function checkActorAccess(req: Request, entity: string, action: 'read' | 'write'): void {
  const ctx = (req as any).actorContext;
  if (!ctx) return; // No X-Actor-Token = admin mode, pass through
  const resolved = resolvePermission(ctx, entity, action);
  if (resolved.level === 'none') {
    throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', `Actor lacks ${entity}:${action} permission`);
  }
}

// Map DB row (snake_case) to the protocol's SigningTask shape (camelCase).
// The signer package uses `chain` (not `chainId`) per external-signer-protocol.
export function toSignerTask(t: any): unknown {
  return {
    id: t.id,
    tenantId: t.tenant_id,
    signerId: t.signer_id,
    requestType: t.request_type,
    chain: t.chain_id,
    assetId: t.asset_id,
    withdrawalBatchId: t.withdrawal_batch_id,
    sweepId: t.sweep_id,
    amountRaw: t.amount_raw,
    feeRaw: t.fee_raw,
    feeRateSatVb: t.fee_rate_sat_vb != null ? Number(t.fee_rate_sat_vb) : null,
    outputsCount: t.outputs_count,
    payloadFormat: t.payload_format,
    unsignedPayload: t.unsigned_payload,
    unsignedPayloadHash: t.unsigned_payload_hash,
    status: t.status,
    decisionMode: t.decision_mode,
    decisionReason: t.decision_reason,
    claimedBySignerId: t.claimed_by_signer_id,
    claimedAt: t.claimed_at,
    expiresAt: t.expires_at,
    signedPayload: t.signed_payload,
    signedPayloadHash: t.signed_payload_hash,
    signerFingerprint: t.signer_fingerprint,
    signerResponseSignature: t.signer_response_signature,
    signedAt: t.signed_at,
    rejectionReasonCode: t.rejection_reason_code,
    rejectionReasonMessage: t.rejection_reason_message,
    rejectedAt: t.rejected_at,
    txHash: t.tx_hash,
    failureCode: t.failure_code,
    failureMessage: t.failure_message,
    retryCount: t.retry_count,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

// ---- Management endpoints ----

// POST /v1/external-signers/enroll
const enrollSchema = z.object({
  name: z.string().min(1).max(200),
  edition: z.enum(['community', 'enterprise']).optional(),
  publicKey: z.string().min(1),
  signerFingerprint: z.string().min(1),
  capabilities: z.object({
    chains: z.array(z.string()),
    assets: z.array(z.string()),
    formats: z.array(z.string()),
  }),
  connectivityMode: z.enum(['polling', 'callback']).optional(),
  securityLevel: z.enum(['basic', 'hardened', 'regulated']).optional(),
  keyProvider: z.enum(['local_file', 'env', 'db_encrypted', 'vault', 'hsm', 'kms']).optional(),
});

externalSignersRouter.post('/enroll', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = enrollSchema.parse(req.body);
    const signer = externalSignersService.enroll(tenantId(req), body);
    res.status(201).json({ data: signer });
  } catch (err) { next(err); }
});

// GET /v1/external-signers/policies — MUST be before /:signerId
externalSignersRouter.get('/policies', (req: Request, res: Response, next: NextFunction) => {
  try {
    const policies = signerPolicyService.listPolicies(tenantId(req));
    res.json({ data: policies });
  } catch (err) { next(err); }
});

// PUT /v1/external-signers/policies
const policyItemSchema = z.object({
  signerId: z.string().optional(),
  chainId: z.string().optional(),
  assetId: z.string().optional(),
  autoSignLimitRaw: z.string().optional(),
  manualApprovalFromRaw: z.string().optional(),
  dailyAutoSignLimitRaw: z.string().optional(),
  maxSignaturesPerHour: z.number().int().positive().optional(),
  maxFeeRateSatVb: z.number().int().positive().optional(),
  maxOutputsPerBatch: z.number().int().positive().optional(),
  destinationAllowlist: z.array(z.string()).optional(),
  contractAllowlist: z.array(z.string()).optional(),
});

externalSignersRouter.put('/policies', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({ policies: z.array(policyItemSchema) }).parse(req.body);
    const result = signerPolicyService.upsertPolicies(tenantId(req), body.policies);
    res.json({ data: result });
  } catch (err) { next(err); }
});

// GET /v1/external-signers
externalSignersRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    checkActorAccess(req, 'external-signer', 'read');
    const signers = externalSignersService.list(tenantId(req));
    res.json({ data: signers });
  } catch (err) { next(err); }
});

// GET /v1/external-signers/:signerId
externalSignersRouter.get('/:signerId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const signer = externalSignersService.getById(tenantId(req), req.params['signerId']!);
    res.json({ data: signer });
  } catch (err) { next(err); }
});

// PATCH /v1/external-signers/:signerId
const patchSignerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
});

externalSignersRouter.patch('/:signerId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = patchSignerSchema.parse(req.body);
    const signer = externalSignersService.update(tenantId(req), req.params['signerId']!, body);
    res.json({ data: signer });
  } catch (err) { next(err); }
});

// POST /v1/external-signers/:signerId/enable
externalSignersRouter.post('/:signerId/enable', (req: Request, res: Response, next: NextFunction) => {
  try {
    const signer = externalSignersService.enable(tenantId(req), req.params['signerId']!);
    res.json({ data: signer });
  } catch (err) { next(err); }
});

// POST /v1/external-signers/:signerId/disable
externalSignersRouter.post('/:signerId/disable', (req: Request, res: Response, next: NextFunction) => {
  try {
    const signer = externalSignersService.disable(tenantId(req), req.params['signerId']!);
    res.json({ data: signer });
  } catch (err) { next(err); }
});

// DELETE /v1/external-signers/:signerId (soft delete = revoke)
externalSignersRouter.delete('/:signerId', (req: Request, res: Response, next: NextFunction) => {
  try {
    externalSignersService.delete(tenantId(req), req.params['signerId']!);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ---- Signer protocol endpoints ----

// POST /v1/external-signers/:signerId/heartbeat
const heartbeatSchema = z.object({
  status: z.string(),
  version: z.string().optional(),
  capabilities: z.unknown().optional(),
  keyFingerprints: z.array(z.string()).optional(),
  time: z.string().optional(),
});

externalSignersRouter.post('/:signerId/heartbeat', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = heartbeatSchema.parse(req.body);
    const signer = externalSignersService.heartbeat(tenantId(req), req.params['signerId']!, body);
    res.json({
      data: {
        signerId: signer.id,
        status: signer.status,
        serverTime: new Date().toISOString(),
      },
    });
  } catch (err) { next(err); }
});

// GET /v1/external-signers/:signerId/tasks
externalSignersRouter.get('/:signerId/tasks', (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt((req.query['limit'] as string) || '10', 10), 50);
    const tasks = signingTasksService.listAvailableForSigner(tenantId(req), req.params['signerId']!, limit);
    res.json({ items: tasks.map(toSignerTask) });
  } catch (err) { next(err); }
});

// POST /v1/external-signers/:signerId/tasks/:taskId/claim
externalSignersRouter.post('/:signerId/tasks/:taskId/claim', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await signingTasksService.claimTask(
      tenantId(req),
      req.params['taskId']!,
      req.params['signerId']!
    );
    res.json({ data: toSignerTask(task) });
  } catch (err) { next(err); }
});

// POST /v1/external-signers/:signerId/tasks/:taskId/submit
const submitSchema = z.object({
  signedPayload: z.string().min(1),
  signedPayloadHash: z.string().min(1),
  signerFingerprint: z.string(),
  signerResponseSignature: z.string().optional(),
  signedAt: z.string().optional(),
});

externalSignersRouter.post('/:signerId/tasks/:taskId/submit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = submitSchema.parse(req.body);
    const task = await signingTasksService.submitSignedTask(
      tenantId(req),
      req.params['taskId']!,
      req.params['signerId']!,
      body
    );
    res.json({ data: task });
  } catch (err) { next(err); }
});

// POST /v1/external-signers/:signerId/tasks/:taskId/reject
const rejectSchema = z.object({
  reasonCode: z.string(),
  reasonMessage: z.string(),
  rejectedAt: z.string().optional(),
});

externalSignersRouter.post('/:signerId/tasks/:taskId/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = rejectSchema.parse(req.body);
    const task = await signingTasksService.rejectTask(
      tenantId(req),
      req.params['taskId']!,
      req.params['signerId']!,
      body
    );
    res.json({ data: task });
  } catch (err) { next(err); }
});
