import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { customersService } from './customers.service';
import { depositAddressService } from './deposit-address.service';
import { issueCustomerToken } from '../../shared/customer-auth/jwt.service';
import { tenantsService } from '../tenants/tenants.service';

export const customersRouter = Router();

const createSchema = z.object({
  reference: z.string().min(1).max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  reference: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'disabled', 'frozen']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  status: z.string().optional(),
});

const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

function tenantId(req: Request): string {
  return (req as any).tenantId as string;
}

// POST /v1/customers
customersRouter.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createSchema.parse(req.body);
    const customer = customersService.create(tenantId(req), body);
    res.status(201).json({ data: customer });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers
customersRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = customersService.list(tenantId(req), query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers/:customerId
customersRouter.get('/:customerId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const customer = customersService.getById(tenantId(req), req.params['customerId']!);
    res.json({ data: customer });
  } catch (err) {
    next(err);
  }
});

// PATCH /v1/customers/:customerId
customersRouter.patch('/:customerId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateSchema.parse(req.body);
    const customer = customersService.update(tenantId(req), req.params['customerId']!, body);
    res.json({ data: customer });
  } catch (err) {
    next(err);
  }
});

// POST /v1/customers/:customerId/disable
customersRouter.post('/:customerId/disable', (req: Request, res: Response, next: NextFunction) => {
  try {
    const customer = customersService.disable(tenantId(req), req.params['customerId']!);
    res.json({ data: customer });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers/:customerId/balances
customersRouter.get('/:customerId/balances', (req: Request, res: Response, next: NextFunction) => {
  try {
    const balances = customersService.getBalances(tenantId(req), req.params['customerId']!);
    res.json({ data: balances });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers/:customerId/deposits
customersRouter.get('/:customerId/deposits', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = customersService.getDeposits(tenantId(req), req.params['customerId']!, query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/customers/:customerId/addresses
customersRouter.get('/:customerId/addresses', (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = paginationQuery.parse(req.query);
    const result = customersService.getAddresses(tenantId(req), req.params['customerId']!, query);
    res.json({
      data: result.data,
      pagination: { limit: query.limit ?? 20, cursor: query.cursor ?? null, nextCursor: result.nextCursor },
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/customers/:customerId/deposit-address
// Derives the next BTC deposit address from the tenant's xpub using BIP32.
// Requires btcXpub to be configured on the tenant (PATCH /admin/v1/tenants/:id/config).
customersRouter.post('/:customerId/deposit-address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    customersService.getById(tenantId(req), req.params['customerId']!); // 404 guard
    const result = await depositAddressService.generateForCustomer(
      tenantId(req),
      req.params['customerId']!
    );
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// POST /v1/customers/:customerId/sessions
// Issues a short-lived customer session token (JWT). Requires tenant API key.
// The returned token is passed to the customer's frontend to call /v1/me/* directly.
customersRouter.post('/:customerId/sessions', (req: Request, res: Response, next: NextFunction) => {
  try {
    const customer = customersService.getById(tenantId(req), req.params['customerId']!); // 404 guard
    if (customer.status !== 'active') {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: `Customer account is ${customer.status}` },
      });
      return;
    }
    const tenantWithConfig = tenantsService.getById(tenantId(req));
    const ttl = tenantWithConfig.config?.customer_session_ttl_seconds ?? undefined;
    const { accessToken, expiresAt } = issueCustomerToken(tenantId(req), customer.id, ttl);
    res.status(201).json({ data: { accessToken, expiresAt, customerId: customer.id } });
  } catch (err) {
    next(err);
  }
});
