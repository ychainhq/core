import request from 'supertest';
import { bootstrapApp, ADMIN_AUTH, AUTH, TEST_TENANT_ID, teardownDb } from './helpers';

const app = bootstrapApp();
afterAll(() => teardownDb());

function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

async function createCustomerAndSession(auth: Record<string, string>): Promise<{ customerId: string; token: string }> {
  const customerRes = await request(app)
    .post('/v1/customers')
    .set(auth)
    .send({ reference: `mcp-customer-${Date.now()}` });
  expect(customerRes.status).toBe(201);

  const sessionRes = await request(app)
    .post(`/v1/customers/${customerRes.body.data.id}/sessions`)
    .set(auth);
  expect(sessionRes.status).toBe(201);

  return { customerId: customerRes.body.data.id, token: sessionRes.body.data.accessToken };
}

function mcpPost(path: string) {
  return request(app)
    .post(path)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
}

describe('MCP tenant endpoint', () => {
  it('requires tenant auth', async () => {
    const res = await request(app)
      .post('/mcp/tenant')
      .send(rpc(1, 'tools/list'));

    expect(res.status).toBe(401);
    expect(res.body.error.data.code).toBe('UNAUTHORIZED');
  });

  it('lists tenant tools and excludes customer/admin-only tools', async () => {
    const res = await mcpPost('/mcp/tenant')
      .set(AUTH)
      .send(rpc(1, 'tools/list'));

    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t: any) => t.name);
    expect(names).toContain('chainapi_get_tenant');
    expect(names).toContain('chainapi_create_customer');
    expect(names).toContain('chainapi_submit_signed_withdrawal');
    expect(names).not.toContain('chainapi_me_get_profile');
    expect(names).not.toContain('chainapi_admin_list_tenants');
  });

  it('calls a tenant read tool with tenant scope', async () => {
    const res = await mcpPost('/mcp/tenant')
      .set(AUTH)
      .send(rpc(2, 'tools/call', {
        name: 'chainapi_get_tenant',
        arguments: {},
      }));

    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.data.id).toBe(TEST_TENANT_ID);
    expect(res.body.result.isError).toBeUndefined();
  });

  it('chainapi_get_sweeps_summary — no args defaults to bitcoin', async () => {
    const res = await mcpPost('/mcp/tenant')
      .set(AUTH)
      .send(rpc(3, 'tools/call', {
        name: 'chainapi_get_sweeps_summary',
        arguments: {},
      }));

    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeUndefined();
    const data = res.body.result.structuredContent.data;
    expect(data.chain_id).toBe('bitcoin');
    expect(data.asset_id).toBe('bitcoin:BTC');
  });

  it('chainapi_get_sweeps_summary — explicit tron/TRX params forwarded', async () => {
    const res = await mcpPost('/mcp/tenant')
      .set(AUTH)
      .send(rpc(4, 'tools/call', {
        name: 'chainapi_get_sweeps_summary',
        arguments: { chainId: 'tron', assetId: 'tron:TRX' },
      }));

    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeUndefined();
    const data = res.body.result.structuredContent.data;
    expect(data.chain_id).toBe('tron');
    expect(data.asset_id).toBe('tron:TRX');
    expect(data.total_utxos).toBeNull();
  });

  it('chainapi_get_sweeps_summary — tron:USDT returns asset_id and null threshold', async () => {
    const res = await mcpPost('/mcp/tenant')
      .set(AUTH)
      .send(rpc(5, 'tools/call', {
        name: 'chainapi_get_sweeps_summary',
        arguments: { chainId: 'tron', assetId: 'tron:USDT' },
      }));

    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeUndefined();
    const data = res.body.result.structuredContent.data;
    expect(data.chain_id).toBe('tron');
    expect(data.asset_id).toBe('tron:USDT');
    expect(data.threshold_raw).toBeNull();
    expect(data.total_utxos).toBeNull();
  });

  it('chainapi_list_sweeps — chainId filter passed through', async () => {
    const res = await mcpPost('/mcp/tenant')
      .set(AUTH)
      .send(rpc(5, 'tools/call', {
        name: 'chainapi_list_sweeps',
        arguments: { chainId: 'bitcoin' },
      }));

    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeUndefined();
    const data = res.body.result.structuredContent.data;
    expect(Array.isArray(data)).toBe(true);
    data.forEach((s: any) => expect(s.chain_id).toBe('bitcoin'));
  });
});

describe('MCP customer endpoint', () => {
  it('lists only customer tools', async () => {
    const { token } = await createCustomerAndSession(AUTH);

    const res = await mcpPost('/mcp/customer')
      .set({ Authorization: `Bearer ${token}` })
      .send(rpc(1, 'tools/list'));

    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t: any) => t.name);
    expect(names).toContain('chainapi_me_get_profile');
    expect(names).toContain('chainapi_me_list_addresses');
    expect(names).not.toContain('chainapi_get_tenant');
    expect(names).not.toContain('chainapi_admin_list_tenants');
  });

  it('rejects a tenant API key on customer MCP', async () => {
    const res = await mcpPost('/mcp/customer')
      .set(AUTH)
      .send(rpc(1, 'tools/list'));

    expect(res.status).toBe(401);
  });
});

describe('MCP admin endpoint', () => {
  it('lists admin tools with admin auth', async () => {
    const res = await mcpPost('/mcp/admin')
      .set(ADMIN_AUTH)
      .send(rpc(1, 'tools/list'));

    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t: any) => t.name);
    expect(names).toContain('chainapi_admin_list_tenants');
    expect(names).toContain('chainapi_admin_create_tenant_api_key');
    expect(names).not.toContain('chainapi_get_tenant');
    expect(names).not.toContain('chainapi_me_get_profile');
  });
});
