import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { paymentRequestsService } from './payment-requests.service';
import { idempotencyService } from '../idempotency/idempotency.service';
import { NotImplementedError } from '../../shared/errors/index';

export const paymentRequestsRouter = Router();

const createSchema = z.object({
  chain: z.string().min(1),
  asset: z.string().min(1),
  amount: z.string().min(1),
  walletId: z.string().optional(),
  address: z.string().optional(),
  customerId: z.string().optional(),
  reference: z.string().max(200).optional(),
  expiresAt: z.string().datetime().optional(),
  confirmationsRequired: z.number().int().min(0).max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  chain: z.string().optional(),
  reference: z.string().optional(),
  walletId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

// NOTE: Order matters — static routes must come before :paymentRequestId
// to avoid matching 'by-reference' as an ID.

// GET /v1/payment-requests/by-reference/:reference
paymentRequestsRouter.get('/by-reference/:reference', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const requests = paymentRequestsService.getByReference(tenantId, req.params['reference']!);
    res.json({ data: requests });
  } catch (err) {
    next(err);
  }
});

// POST /v1/payment-requests
paymentRequestsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (idempotencyKey) {
      const existing = idempotencyService.get(tenantId, idempotencyKey, 'payment_request');
      if (existing) {
        res.status(existing.statusCode).json(existing.result);
        return;
      }
    }

    const body = createSchema.parse(req.body);
    const paymentRequest = paymentRequestsService.create(tenantId, body);

    const result = { data: paymentRequest };
    if (idempotencyKey) {
      idempotencyService.save(tenantId, idempotencyKey, 'payment_request', result, 201);
    }

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /v1/payment-requests
paymentRequestsRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const query = listQuerySchema.parse(req.query);
    const result = paymentRequestsService.list(tenantId, query);
    res.json({
      data: result.data,
      pagination: {
        limit: query.limit ?? 20,
        cursor: query.cursor ?? null,
        nextCursor: result.nextCursor,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/payment-requests/:paymentRequestId
paymentRequestsRouter.get('/:paymentRequestId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const pr = paymentRequestsService.getById(tenantId, req.params['paymentRequestId']!);
    res.json({ data: pr });
  } catch (err) {
    next(err);
  }
});

// POST /v1/payment-requests/:paymentRequestId/cancel
paymentRequestsRouter.post('/:paymentRequestId/cancel', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const pr = paymentRequestsService.cancel(tenantId, req.params['paymentRequestId']!);
    res.json({ data: pr });
  } catch (err) {
    next(err);
  }
});

// GET /v1/payment-requests/:paymentRequestId/qr
paymentRequestsRouter.get('/:paymentRequestId/qr', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const formatQuery = z.object({ format: z.string().optional() }).parse(req.query);
    const pr = paymentRequestsService.getById(tenantId, req.params['paymentRequestId']!);

    // Only 'payload' format is supported in beta; svg/png returns 501
    if (formatQuery.format && formatQuery.format !== 'payload') {
      throw new NotImplementedError(`QR format '${formatQuery.format}'`);
    }

    res.json({
      data: {
        paymentRequestId: pr.id,
        format: 'payload',
        qrPayload: pr.qr_payload,
      },
    });
  } catch (err) {
    next(err);
  }
});
