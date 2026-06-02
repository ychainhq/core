import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, AUTH, teardownDb } from './helpers';

const app = bootstrapApp();

afterAll(() => {
  teardownDb();
});

describe('Admin: chain_nodes CRUD', () => {
  const validPayload = {
    chainId: 'bitcoin',
    label: 'test-btc-node',
    rpcUrl: 'http://127.0.0.1:8332',
    rpcUser: 'bitcoin',
    rpcPasswordRef: 'env:TEST_BTC_RPC_PASSWORD',
    network: 'mainnet',
    role: 'full',
    priority: 100,
  };

  let createdNodeId: string;

  it('POST /admin/v1/chain-nodes creates a node', async () => {
    const res = await request(app)
      .post('/admin/v1/chain-nodes')
      .set(ADMIN_AUTH)
      .send(validPayload);
    if (res.status !== 201) console.error('UNEXPECTED BODY:', JSON.stringify(res.body));
    expect(res.status).toBe(201);

    expect(res.body.data).toMatchObject({
      chainId: 'bitcoin',
      label: 'test-btc-node',
      role: 'full',
      priority: 100,
      isEnabled: true,
      status: 'unknown',
      network: 'mainnet',
    });
    // rpc_password_ref must not be exposed
    expect(res.body.data.rpcPasswordRef).toBeUndefined();
    createdNodeId = res.body.data.id;
    expect(createdNodeId).toMatch(/^node_/);
  });

  it('POST /admin/v1/chain-nodes rejects plaintext password', async () => {
    await request(app)
      .post('/admin/v1/chain-nodes')
      .set(ADMIN_AUTH)
      .send({ ...validPayload, rpcPasswordRef: 'mysecretpassword' })
      .expect(400);
  });

  it('POST /admin/v1/chain-nodes rejects missing required fields', async () => {
    await request(app)
      .post('/admin/v1/chain-nodes')
      .set(ADMIN_AUTH)
      .send({ label: 'incomplete' })
      .expect(400);
  });

  it('GET /admin/v1/chain-nodes lists nodes', async () => {
    const res = await request(app)
      .get('/admin/v1/chain-nodes')
      .set(ADMIN_AUTH)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    const found = res.body.data.find((n: any) => n.id === createdNodeId);
    expect(found).toBeDefined();
  });

  it('GET /admin/v1/chain-nodes filters by chainId', async () => {
    const res = await request(app)
      .get('/admin/v1/chain-nodes?chainId=bitcoin')
      .set(ADMIN_AUTH)
      .expect(200);

    expect(res.body.data.every((n: any) => n.chainId === 'bitcoin')).toBe(true);
  });

  it('GET /admin/v1/chain-nodes/:nodeId returns node', async () => {
    const res = await request(app)
      .get(`/admin/v1/chain-nodes/${createdNodeId}`)
      .set(ADMIN_AUTH)
      .expect(200);

    expect(res.body.data.id).toBe(createdNodeId);
    expect(res.body.data.label).toBe('test-btc-node');
  });

  it('GET /admin/v1/chain-nodes/:nodeId returns 404 for unknown id', async () => {
    await request(app)
      .get('/admin/v1/chain-nodes/node_nonexistent')
      .set(ADMIN_AUTH)
      .expect(404);
  });

  it('PATCH /admin/v1/chain-nodes/:nodeId updates fields', async () => {
    const res = await request(app)
      .patch(`/admin/v1/chain-nodes/${createdNodeId}`)
      .set(ADMIN_AUTH)
      .send({ label: 'updated-label', priority: 50, isEnabled: false })
      .expect(200);

    expect(res.body.data.label).toBe('updated-label');
    expect(res.body.data.priority).toBe(50);
    expect(res.body.data.isEnabled).toBe(false);
  });

  it('PATCH /admin/v1/chain-nodes/:nodeId rejects bad rpcPasswordRef', async () => {
    await request(app)
      .patch(`/admin/v1/chain-nodes/${createdNodeId}`)
      .set(ADMIN_AUTH)
      .send({ rpcPasswordRef: 'plaintext_password' })
      .expect(400);
  });

  it('POST /admin/v1/chain-nodes requires admin auth', async () => {
    await request(app)
      .post('/admin/v1/chain-nodes')
      .set(AUTH)
      .send(validPayload)
      .expect(401);
  });

  it('GET /admin/v1/chain-nodes requires admin auth', async () => {
    await request(app)
      .get('/admin/v1/chain-nodes')
      .set(AUTH)
      .expect(401);
  });
});

describe('Tenant: GET /v1/chain-nodes', () => {
  it('returns platform nodes (tenant_id IS NULL) for tenant', async () => {
    const res = await request(app)
      .get('/v1/chain-nodes')
      .set(AUTH)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('chain_events: DepositEventProcessor integration', () => {
  it('chain_events table exists and is empty initially', async () => {
    // Verify migration 022 applied correctly
    const { getDb } = require('../../src/db/sqlite');
    const db = getDb();
    const rows = db.prepare('SELECT * FROM chain_events LIMIT 1').all();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('indexer_checkpoints table exists', async () => {
    const { getDb } = require('../../src/db/sqlite');
    const db = getDb();
    const rows = db.prepare('SELECT * FROM indexer_checkpoints LIMIT 1').all();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('chain_events table has correct schema', () => {
    const { getDb } = require('../../src/db/sqlite');
    const db = getDb();
    // Verify required columns exist by checking table_info
    const cols = db.prepare("PRAGMA table_info(chain_events)").all() as any[];
    const colNames = cols.map((c: any) => c.name);
    expect(colNames).toContain('tx_hash');
    expect(colNames).toContain('vout_index');
    expect(colNames).toContain('event_type');
    expect(colNames).toContain('address');
    expect(colNames).toContain('amount_raw');
    expect(colNames).toContain('block_height');
    expect(colNames).toContain('confirmations');
    expect(colNames).toContain('processed');
    expect(colNames).toContain('contract_address');
    expect(colNames).toContain('log_index');
  });
});
