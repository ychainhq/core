import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { withdrawalsService } from './withdrawals.service';

export const withdrawalsRouter = Router();

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const submitSignedSchema = z.object({
  signedPsbt: z.string().min(1),
});

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

// GET /v1/withdrawals — tenant-level view of all customer withdrawals
withdrawalsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = withdrawalsService.listForTenant(tenantId(req), query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/withdrawals/:withdrawalId
withdrawalsRouter.get('/:withdrawalId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const withdrawal = withdrawalsService.getById(tenantId(req), req.params['withdrawalId']!);
    res.json({ data: withdrawal });
  } catch (err) {
    next(err);
  }
});

// POST /v1/withdrawals/:withdrawalId/submit-signed
// Called by the tenant's signing daemon after signing the PSBT from the webhook.
withdrawalsRouter.post('/:withdrawalId/submit-signed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = submitSignedSchema.parse(req.body);
    const updated = await withdrawalsService.submitSigned(
      tenantId(req),
      req.params['withdrawalId']!,
      body.signedPsbt
    );
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});
