import request from 'supertest';
import { bootstrapApp, AUTH, teardownDb } from './helpers';

const app = bootstrapApp();

afterAll(() => teardownDb());

describe('GET /health', () => {
  it('returns 200 with ok status — no auth required', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('0.1.0-beta');
    expect(res.body.timestamp).toBeDefined();
  });

  it('does not require Authorization header', async () => {
    const res = await request(app).get('/health');
    expect(res.status).not.toBe(401);
  });
});

describe('Auth middleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app).get('/v1/chains');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for wrong API key', async () => {
    const res = await request(app)
      .get('/v1/chains')
      .set('Authorization', 'Bearer wrong_key_totally_invalid');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for malformed Authorization header (no Bearer)', async () => {
    const res = await request(app)
      .get('/v1/chains')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });

  it('accepts valid API key', async () => {
    const res = await request(app).get('/v1/chains').set(AUTH);
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown endpoint (not 401)', async () => {
    const res = await request(app).get('/v1/does-not-exist').set(AUTH);
    // unknown endpoint inside /v1 returns 404 after auth passes
    expect(res.status).toBe(404);
  });
});
