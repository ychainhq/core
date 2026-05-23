/**
 * External Signers Service
 *
 * Manages signer enrollment, heartbeat, CRUD, and round-robin selection.
 * Each signer is tenant-scoped.
 */

import crypto from 'crypto';
import { getDb } from '../../db/sqlite';
import { NotFoundError, ValidationError, ConflictError } from '../../shared/errors/index';
import { logger } from '../../shared/logging/index';

export interface ExternalSigner {
  id: string;
  tenant_id: string;
  name: string;
  edition: string;
  status: string;
  is_enabled: number;
  connectivity_mode: string;
  security_level: string;
  key_provider: string;
  public_key: string;
  signer_fingerprint: string;
  client_cert_fingerprint: string | null;
  capabilities: string;         // JSON string
  last_seen_at: string | null;
  last_health_status: string | null;
  last_error: string | null;
  round_robin_weight: number;
  round_robin_cursor: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnrollSignerInput {
  name: string;
  edition?: string;
  publicKey: string;
  signerFingerprint: string;
  capabilities: {
    chains: string[];
    assets: string[];
    formats: string[];
  };
  connectivityMode?: string;
  securityLevel?: string;
  keyProvider?: string;
}

export const externalSignersService = {
  enroll(tenantId: string, input: EnrollSignerInput): ExternalSigner {
    const db = getDb();

    // Check for duplicate fingerprint within tenant
    const existing = db
      .prepare('SELECT * FROM external_signers WHERE tenant_id = ? AND signer_fingerprint = ?')
      .get(tenantId, input.signerFingerprint) as ExternalSigner | undefined;

    if (existing) {
      // Idempotent — return existing signer
      return existing;
    }

    const id = `sgn_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO external_signers (
        id, tenant_id, name, edition, status, is_enabled,
        connectivity_mode, security_level, key_provider,
        public_key, signer_fingerprint,
        capabilities, round_robin_weight, round_robin_cursor,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    `).run(
      id, tenantId, input.name,
      input.edition ?? 'community',
      input.connectivityMode ?? 'polling',
      input.securityLevel ?? 'basic',
      input.keyProvider ?? 'local_file',
      input.publicKey,
      input.signerFingerprint,
      JSON.stringify(input.capabilities),
      now, now
    );

    logger.info('External signer enrolled', { id, tenantId, name: input.name });
    return externalSignersService.getByIdInternal(id);
  },

  list(tenantId: string, filters: { status?: string; enabled?: boolean } = {}): ExternalSigner[] {
    const db = getDb();
    let query = 'SELECT * FROM external_signers WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters.enabled !== undefined) {
      query += ' AND is_enabled = ?';
      params.push(filters.enabled ? 1 : 0);
    }

    query += ' ORDER BY created_at DESC';
    return db.prepare(query).all(...params) as ExternalSigner[];
  },

  getById(tenantId: string, signerId: string): ExternalSigner {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM external_signers WHERE id = ? AND tenant_id = ?'
    ).get(signerId, tenantId) as ExternalSigner | undefined;

    if (!row) throw new NotFoundError('ExternalSigner', signerId);
    return row;
  },

  getByIdInternal(signerId: string): ExternalSigner {
    const db = getDb();
    const row = db.prepare('SELECT * FROM external_signers WHERE id = ?').get(signerId) as ExternalSigner | undefined;
    if (!row) throw new NotFoundError('ExternalSigner', signerId);
    return row;
  },

  update(tenantId: string, signerId: string, input: {
    name?: string;
    is_enabled?: boolean;
    metadata?: Record<string, unknown>;
  }): ExternalSigner {
    // Verify exists
    externalSignersService.getById(tenantId, signerId);

    const db = getDb();
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name); }
    if (input.is_enabled !== undefined) { sets.push('is_enabled = ?'); params.push(input.is_enabled ? 1 : 0); }
    if (input.metadata !== undefined) { sets.push('metadata = ?'); params.push(JSON.stringify(input.metadata)); }

    params.push(signerId);
    db.prepare(`UPDATE external_signers SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return externalSignersService.getByIdInternal(signerId);
  },

  enable(tenantId: string, signerId: string): ExternalSigner {
    externalSignersService.getById(tenantId, signerId);
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare('UPDATE external_signers SET is_enabled = 1, status = \'active\', updated_at = ? WHERE id = ?').run(now, signerId);
    logger.info('External signer enabled', { signerId, tenantId });
    return externalSignersService.getByIdInternal(signerId);
  },

  disable(tenantId: string, signerId: string): ExternalSigner {
    externalSignersService.getById(tenantId, signerId);
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare('UPDATE external_signers SET is_enabled = 0, status = \'disabled\', updated_at = ? WHERE id = ?').run(now, signerId);
    logger.info('External signer disabled', { signerId, tenantId });
    return externalSignersService.getByIdInternal(signerId);
  },

  delete(tenantId: string, signerId: string): void {
    externalSignersService.getById(tenantId, signerId);
    const db = getDb();
    db.prepare('UPDATE external_signers SET status = \'revoked\', is_enabled = 0, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), signerId);
    logger.info('External signer revoked', { signerId, tenantId });
  },

  /**
   * Process a heartbeat from a signer daemon.
   * Updates last_seen_at, health status, and promotes pending→active.
   */
  heartbeat(tenantId: string, signerId: string, input: {
    status: string;
    version?: string;
    capabilities?: unknown;
    keyFingerprints?: string[];
    time?: string;
  }): ExternalSigner {
    const signer = externalSignersService.getById(tenantId, signerId);

    if (signer.status === 'revoked' || signer.status === 'suspended') {
      throw new ValidationError(`Signer is ${signer.status} and cannot send heartbeats`);
    }

    const db = getDb();
    const now = new Date().toISOString();
    const newStatus = signer.status === 'pending' ? 'active' : signer.status;

    db.prepare(`
      UPDATE external_signers
      SET last_seen_at = ?, last_health_status = ?, status = ?,
          last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, input.status, newStatus, now, signerId);

    return externalSignersService.getByIdInternal(signerId);
  },

  /**
   * Select the best eligible signer for a given chain/asset/format
   * using health-aware round-robin.
   */
  selectSigner(tenantId: string, chainId: string, assetId: string, payloadFormat: string): ExternalSigner | null {
    const db = getDb();
    const staleThresholdMs = 120_000; // 2 minutes
    const staleThreshold = new Date(Date.now() - staleThresholdMs).toISOString();

    const signers = db.prepare(`
      SELECT * FROM external_signers
      WHERE tenant_id = ?
        AND is_enabled = 1
        AND status = 'active'
        AND last_health_status = 'healthy'
        AND last_seen_at > ?
      ORDER BY round_robin_cursor ASC, created_at ASC
    `).all(tenantId, staleThreshold) as ExternalSigner[];

    // Filter by capabilities
    const eligible = signers.filter(s => {
      try {
        const caps = JSON.parse(s.capabilities);
        return (
          caps.chains?.includes(chainId) &&
          caps.assets?.includes(assetId) &&
          caps.formats?.includes(payloadFormat)
        );
      } catch {
        return false;
      }
    });

    if (eligible.length === 0) return null;

    const selected = eligible[0]!;

    // Update cursor for next round-robin
    db.prepare('UPDATE external_signers SET round_robin_cursor = round_robin_cursor + 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), selected.id);

    return selected;
  },
};
