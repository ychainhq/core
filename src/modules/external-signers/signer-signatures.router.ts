/**
 * Signer Signatures (Audit) Router
 *
 * GET /v1/signer-signatures   — list signature audit log entries
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../../db/sqlite';

export const signerSignaturesRouter = Router();

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

// GET /v1/signer-signatures
signerSignaturesRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt((req.query['limit'] as string) || '20', 10), 100);
    const cursor = req.query['cursor'] as string | undefined;
    const signerId = req.query['signerId'] as string | undefined;
    const chainId = req.query['chainId'] as string | undefined;
    const result = req.query['result'] as string | undefined;

    let query = 'SELECT * FROM signer_signature_audit WHERE tenant_id = ?';
    const params: unknown[] = [tenantId(req)];

    if (signerId) { query += ' AND signer_id = ?'; params.push(signerId); }
    if (chainId) { query += ' AND chain_id = ?'; params.push(chainId); }
    if (result) { query += ' AND signature_result = ?'; params.push(result); }
    if (cursor) { query += ' AND id > ?'; params.push(cursor); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      data: items,
      pagination: { limit, cursor: cursor ?? null, nextCursor: hasMore ? items[items.length - 1]?.id : null },
    });
  } catch (err) { next(err); }
});
