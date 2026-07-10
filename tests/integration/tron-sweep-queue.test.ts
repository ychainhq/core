import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, AUTH, teardownDb } from './helpers';

const app = bootstrapApp();
afterAll(() => teardownDb());

describe('GET /admin/v1/tron/sweep-queue-stats', () => {
  it('requires admin auth', async () => {
    const res = await request(app)
      .get('/admin/v1/tron/sweep-queue-stats');
    expect(res.status).toBe(401);
  });

  it('rejects tenant auth', async () => {
    const res = await request(app)
      .get('/admin/v1/tron/sweep-queue-stats')
      .set(AUTH);
    expect(res.status).toBe(401);
  });

  it('returns empty stats with correct shape on fresh DB', async () => {
    const res = await request(app)
      .get('/admin/v1/tron/sweep-queue-stats')
      .set(ADMIN_AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.sweep_queue).toBeDefined();
    expect(typeof res.body.data.sweep_queue.total).toBe('number');
    expect(res.body.data.sweep_queue.total).toBe(0);
    expect(res.body.data.energy_delegations).toBeDefined();
    expect(typeof res.body.data.energy_delegations.total).toBe('number');
  });
});
