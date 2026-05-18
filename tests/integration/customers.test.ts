import request from 'supertest';
import { bootstrapApp, AUTH, teardownDb } from './helpers';

const app = bootstrapApp();

afterAll(() => teardownDb());

describe('POST /v1/customers', () => {
  it('creates a customer with no body', async () => {
    const res = await request(app).post('/v1/customers').set(AUTH).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.id).toMatch(/^cust_/);
    expect(res.body.data.status).toBe('active');
  });

  it('creates a customer with reference and metadata', async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'user-abc-123', metadata: { plan: 'pro' } });
    expect(res.status).toBe(201);
    expect(res.body.data.reference).toBe('user-abc-123');
    expect(res.body.data.metadata).toEqual({ plan: 'pro' });
  });

  it('rejects duplicate reference', async () => {
    await request(app).post('/v1/customers').set(AUTH).send({ reference: 'dup-ref-001' });
    const res = await request(app).post('/v1/customers').set(AUTH).send({ reference: 'dup-ref-001' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects missing auth', async () => {
    const res = await request(app).post('/v1/customers').send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/customers', () => {
  beforeAll(async () => {
    await request(app).post('/v1/customers').set(AUTH).send({ reference: 'list-test-1' });
    await request(app).post('/v1/customers').set(AUTH).send({ reference: 'list-test-2' });
  });

  it('returns paginated list', async () => {
    const res = await request(app).get('/v1/customers').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.pagination).toBeDefined();
  });

  it('respects limit', async () => {
    const res = await request(app).get('/v1/customers?limit=1').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.pagination.nextCursor).toBeTruthy();
  });

  it('filters by status=active', async () => {
    const res = await request(app).get('/v1/customers?status=active').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.every((c: any) => c.status === 'active')).toBe(true);
  });
});

describe('GET /v1/customers/:customerId', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'get-by-id-test', metadata: { tier: 'gold' } });
    customerId = res.body.data.id;
  });

  it('returns customer by id', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(customerId);
    expect(res.body.data.reference).toBe('get-by-id-test');
    expect(res.body.data.metadata).toEqual({ tier: 'gold' });
  });

  it('returns 404 for non-existent customer', async () => {
    const res = await request(app).get('/v1/customers/cust_nonexistent').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /v1/customers/:customerId', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'patch-test' });
    customerId = res.body.data.id;
  });

  it('updates customer reference', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}`)
      .set(AUTH)
      .send({ reference: 'patch-test-updated' });
    expect(res.status).toBe(200);
    expect(res.body.data.reference).toBe('patch-test-updated');
  });

  it('updates customer status', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}`)
      .set(AUTH)
      .send({ status: 'frozen' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('frozen');
  });

  it('rejects invalid status', async () => {
    const res = await request(app)
      .patch(`/v1/customers/${customerId}`)
      .set(AUTH)
      .send({ status: 'invalid_status' });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/customers/:customerId/disable', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'disable-test' });
    customerId = res.body.data.id;
  });

  it('disables customer', async () => {
    const res = await request(app)
      .post(`/v1/customers/${customerId}/disable`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('disabled');
  });
});

describe('GET /v1/customers/:customerId/balances', () => {
  let customerId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/v1/customers')
      .set(AUTH)
      .send({ reference: 'balances-test' });
    customerId = res.body.data.id;
  });

  it('returns 200 with array', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/balances`).set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns exactly one entry per asset_id — not one per ledger account', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/balances`).set(AUTH);
    expect(res.status).toBe(200);
    const assetIds = res.body.data.map((b: any) => b.asset_id);
    const unique = new Set(assetIds);
    expect(unique.size).toBe(assetIds.length);
  });

  it('each balance entry has pending, settled, total fields', async () => {
    const res = await request(app).get(`/v1/customers/${customerId}/balances`).set(AUTH);
    expect(res.status).toBe(200);
    for (const balance of res.body.data) {
      expect(balance).toHaveProperty('asset_id');
      expect(balance).toHaveProperty('pending');
      expect(balance).toHaveProperty('settled');
      expect(balance).toHaveProperty('total');
    }
  });

  it('returns 404 for non-existent customer', async () => {
    const res = await request(app).get('/v1/customers/cust_nonexistent/balances').set(AUTH);
    expect(res.status).toBe(404);
  });
});
