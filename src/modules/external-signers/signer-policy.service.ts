/**
 * Signer Policy Service
 *
 * Resolves signing policies with 6-level precedence:
 * 1. signer + asset
 * 2. signer + chain
 * 3. signer (global)
 * 4. tenant + asset
 * 5. tenant + chain
 * 6. tenant (global)
 */

import { getDb } from '../../db/sqlite';

export interface SignerPolicy {
  id: string;
  tenant_id: string;
  signer_id: string | null;
  chain_id: string | null;
  asset_id: string | null;
  auto_sign_limit_raw: string | null;
  manual_approval_from_raw: string | null;
  daily_auto_sign_limit_raw: string | null;
  max_signatures_per_hour: number | null;
  max_fee_rate_sat_vb: number | null;
  max_outputs_per_batch: number | null;
  destination_allowlist: string | null;   // JSON
  contract_allowlist: string | null;       // JSON
  is_enabled: number;
  created_at: string;
  updated_at: string;
}

export interface PolicyDecision {
  mode: 'auto' | 'manual';
  reason: string;
  effectivePolicy: SignerPolicy | null;
}

export const signerPolicyService = {
  /**
   * Resolve effective policy using precedence chain.
   */
  resolvePolicy(
    tenantId: string,
    signerId: string | null,
    chainId: string,
    assetId: string
  ): SignerPolicy | null {
    const db = getDb();

    // Build precedence-ordered candidates
    const candidates: Array<{ signer_id: string | null; chain_id: string | null; asset_id: string | null }> = [];

    if (signerId) {
      candidates.push({ signer_id: signerId, chain_id: null, asset_id: assetId });  // 1
      candidates.push({ signer_id: signerId, chain_id: chainId, asset_id: null }); // 2
      candidates.push({ signer_id: signerId, chain_id: null, asset_id: null });    // 3
    }
    candidates.push({ signer_id: null, chain_id: null, asset_id: assetId });        // 4
    candidates.push({ signer_id: null, chain_id: chainId, asset_id: null });        // 5
    candidates.push({ signer_id: null, chain_id: null, asset_id: null });           // 6

    for (const c of candidates) {
      let query = 'SELECT * FROM external_signer_policies WHERE tenant_id = ? AND is_enabled = 1';
      const params: unknown[] = [tenantId];

      if (c.signer_id !== null) {
        query += ' AND signer_id = ?';
        params.push(c.signer_id);
      } else {
        query += ' AND signer_id IS NULL';
      }

      if (c.chain_id !== null) {
        query += ' AND chain_id = ?';
        params.push(c.chain_id);
      } else {
        query += ' AND chain_id IS NULL';
      }

      if (c.asset_id !== null) {
        query += ' AND asset_id = ?';
        params.push(c.asset_id);
      } else {
        query += ' AND asset_id IS NULL';
      }

      query += ' LIMIT 1';

      const row = db.prepare(query).get(...params) as SignerPolicy | undefined;
      if (row) return row;
    }

    return null;
  },

  /**
   * Evaluate whether a batch can be auto-signed or requires manual approval.
   */
  evaluateDecision(
    tenantId: string,
    signerId: string | null,
    chainId: string,
    assetId: string,
    amountRaw: string,
    feeRateSatVb: number,
    outputsCount: number
  ): PolicyDecision {
    const policy = signerPolicyService.resolvePolicy(tenantId, signerId, chainId, assetId);

    if (!policy) {
      // No policy configured — default to manual approval for safety
      return { mode: 'manual', reason: 'no_policy_configured', effectivePolicy: null };
    }

    const amount = BigInt(amountRaw);

    // Check if manual approval threshold is reached
    if (policy.manual_approval_from_raw) {
      const manualThreshold = BigInt(policy.manual_approval_from_raw);
      if (amount >= manualThreshold) {
        return {
          mode: 'manual',
          reason: `amount_exceeds_manual_threshold:${policy.manual_approval_from_raw}`,
          effectivePolicy: policy,
        };
      }
    }

    // Check auto-sign limit
    if (policy.auto_sign_limit_raw) {
      const autoLimit = BigInt(policy.auto_sign_limit_raw);
      if (amount > autoLimit) {
        return {
          mode: 'manual',
          reason: `amount_exceeds_auto_limit:${policy.auto_sign_limit_raw}`,
          effectivePolicy: policy,
        };
      }
    }

    // Check fee rate
    if (policy.max_fee_rate_sat_vb && feeRateSatVb > policy.max_fee_rate_sat_vb) {
      return {
        mode: 'manual',
        reason: `fee_rate_exceeds_limit:${policy.max_fee_rate_sat_vb}`,
        effectivePolicy: policy,
      };
    }

    // Check outputs count
    if (policy.max_outputs_per_batch && outputsCount > policy.max_outputs_per_batch) {
      return {
        mode: 'manual',
        reason: `outputs_count_exceeds_limit:${policy.max_outputs_per_batch}`,
        effectivePolicy: policy,
      };
    }

    return {
      mode: 'auto',
      reason: 'batch_under_auto_limit',
      effectivePolicy: policy,
    };
  },

  listPolicies(tenantId: string, signerId?: string): SignerPolicy[] {
    const db = getDb();
    if (signerId) {
      return db.prepare(
        'SELECT * FROM external_signer_policies WHERE tenant_id = ? AND signer_id = ? ORDER BY created_at DESC'
      ).all(tenantId, signerId) as SignerPolicy[];
    }
    return db.prepare(
      'SELECT * FROM external_signer_policies WHERE tenant_id = ? ORDER BY created_at DESC'
    ).all(tenantId) as SignerPolicy[];
  },

  upsertPolicies(tenantId: string, policies: Array<{
    signerId?: string;
    chainId?: string;
    assetId?: string;
    autoSignLimitRaw?: string;
    manualApprovalFromRaw?: string;
    dailyAutoSignLimitRaw?: string;
    maxSignaturesPerHour?: number;
    maxFeeRateSatVb?: number;
    maxOutputsPerBatch?: number;
    destinationAllowlist?: string[];
    contractAllowlist?: string[];
  }>): SignerPolicy[] {
    const db = getDb();
    const now = new Date().toISOString();

    const upsert = db.transaction(() => {
      const results: SignerPolicy[] = [];

      for (const p of policies) {
        const id = `spl_${require('crypto').randomBytes(8).toString('hex')}`;

        db.prepare(`
          INSERT INTO external_signer_policies (
            id, tenant_id, signer_id, chain_id, asset_id,
            auto_sign_limit_raw, manual_approval_from_raw,
            daily_auto_sign_limit_raw, max_signatures_per_hour,
            max_fee_rate_sat_vb, max_outputs_per_batch,
            destination_allowlist, contract_allowlist,
            is_enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
          id, tenantId,
          p.signerId ?? null,
          p.chainId ?? null,
          p.assetId ?? null,
          p.autoSignLimitRaw ?? null,
          p.manualApprovalFromRaw ?? null,
          p.dailyAutoSignLimitRaw ?? null,
          p.maxSignaturesPerHour ?? null,
          p.maxFeeRateSatVb ?? null,
          p.maxOutputsPerBatch ?? null,
          p.destinationAllowlist ? JSON.stringify(p.destinationAllowlist) : null,
          p.contractAllowlist ? JSON.stringify(p.contractAllowlist) : null,
          now, now
        );

        results.push(db.prepare('SELECT * FROM external_signer_policies WHERE id = ?').get(id) as SignerPolicy);
      }

      return results;
    });

    return upsert();
  },
};
