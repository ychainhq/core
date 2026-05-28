import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { webhooksService } from './webhooks.service';
import { ticklerService } from '../../shared/tickler/tickler.service';
import { resolveActorLogin } from '../../shared/tickler/tickler.actor';

export const webhooksRouter = Router();
export const webhookDeliveriesRouter = Router();

const createSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  chains: z.array(z.string()).optional(),
  walletId: z.string().optional(),
  secret: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string().min(1)).optional(),
  chains: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

const listQuerySchema = z.object({
  walletId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const deliveriesQuerySchema = z.object({
  webhookId: z.string().optional(),
  eventType: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

// POST /v1/webhooks
webhooksRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const body = createSchema.parse(req.body);
    const { webhook, secret } = webhooksService.create(tenantId, body);
    ticklerService.record({
      tenantId,
      category: 'webhook',
      subcategory: 'created',
      entityId: webhook.id,
      actorLogin: resolveActorLogin(req),
      field1: webhook.url,
      newValue: webhook,
    });
    // Return secret only on creation
    res.status(201).json({
      data: {
        ...webhook,
        secret, // Only returned once — store it securely
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/webhooks
webhooksRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const query = listQuerySchema.parse(req.query);
    const result = webhooksService.list(tenantId, query);
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

// GET /v1/webhooks/:webhookId
webhooksRouter.get('/:webhookId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const webhook = webhooksService.getById(tenantId, req.params['webhookId']!);
    res.json({ data: webhook });
  } catch (err) {
    next(err);
  }
});

// PATCH /v1/webhooks/:webhookId
webhooksRouter.patch('/:webhookId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const body = updateSchema.parse(req.body);
    const prev = webhooksService.getById(tenantId, req.params['webhookId']!);
    const webhook = webhooksService.update(tenantId, req.params['webhookId']!, body);
    ticklerService.record({
      tenantId,
      category: 'webhook',
      subcategory: 'updated',
      entityId: webhook.id,
      actorLogin: resolveActorLogin(req),
      prevValue: prev,
      newValue: webhook,
    });
    res.json({ data: webhook });
  } catch (err) {
    next(err);
  }
});

// DELETE /v1/webhooks/:webhookId
webhooksRouter.delete('/:webhookId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const prev = webhooksService.getById(tenantId, req.params['webhookId']!);
    const webhook = webhooksService.deactivate(tenantId, req.params['webhookId']!);
    ticklerService.record({
      tenantId,
      category: 'webhook',
      subcategory: 'deleted',
      entityId: webhook.id,
      actorLogin: resolveActorLogin(req),
      field1: webhook.url,
      prevValue: prev,
    });
    res.json({ data: webhook });
  } catch (err) {
    next(err);
  }
});

// POST /v1/webhooks/:webhookId/test
webhooksRouter.post('/:webhookId/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const webhookId = req.params['webhookId']!;
    const webhook = webhooksService.getById(tenantId, webhookId);
    const secret = webhooksService.getSecret(tenantId, webhookId);

    const timestamp = Date.now();
    const payload = {
      event: 'webhook.test',
      webhookId,
      timestamp: new Date().toISOString(),
      message: 'This is a test event from Chain API',
    };

    const signature = webhooksService.signPayload(secret, timestamp, payload);

    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CryptoApi-Event-Id': `evt_test_${Date.now()}`,
          'X-CryptoApi-Timestamp': String(timestamp),
          'X-CryptoApi-Signature': signature,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      responseStatus = response.status;
      responseBody = await response.text().catch(() => null);
    } catch (fetchErr: any) {
      error = fetchErr.message;
    }

    res.json({
      data: {
        webhookId,
        delivered: responseStatus !== null && responseStatus >= 200 && responseStatus < 300,
        responseStatus,
        responseBody,
        error,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/webhook-deliveries
webhookDeliveriesRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const query = deliveriesQuerySchema.parse(req.query);
    const result = webhooksService.listDeliveries(tenantId, query);
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

// POST /v1/webhook-deliveries/:deliveryId/retry
webhookDeliveriesRouter.post('/:deliveryId/retry', (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenantId as string;
    const delivery = webhooksService.retryDelivery(tenantId, req.params['deliveryId']!);
    res.json({ data: delivery });
  } catch (err) {
    next(err);
  }
});
