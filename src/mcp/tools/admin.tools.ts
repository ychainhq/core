import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { McpAuthContext, requireAdmin } from '../context';
import { safeTool } from '../errors';
import { tenantsService } from '../../modules/tenants/tenants.service';
import { ticklerService } from '../../shared/tickler/tickler.service';

const paging = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
};

const metadata = z.record(z.string(), z.unknown()).optional();

function page<T>(result: { data: T[]; nextCursor: string | null }, input: { limit?: number; cursor?: string }) {
  return {
    data: result.data,
    pagination: { limit: input.limit ?? 20, cursor: input.cursor ?? null, nextCursor: result.nextCursor },
  };
}

export function registerAdminTools(server: McpServer, ctx: McpAuthContext): void {
  requireAdmin(ctx);
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, openWorldHint: false };

  server.registerTool('chainapi_admin_create_tenant', {
    description: 'Create a tenant and provision configured assets. Returned API keys are not created here.',
    inputSchema: {
      name: z.string().min(1).max(200),
      metadata,
      assets: z.array(z.object({
        chain: z.literal('bitcoin'),
        hotAddress: z.string().min(1).optional(),
        coldAddress: z.string().min(1).optional(),
        xpub: z.string().min(1).optional(),
      })).min(1),
    },
    annotations: write,
  }, async ({ assets, ...input }: any) => safeTool(async () => {
    const tenant = tenantsService.create(input);
    await tenantsService.provision(tenant.id, assets);
    return { data: tenantsService.getById(tenant.id) };
  }));

  server.registerTool('chainapi_admin_list_tenants', {
    description: 'List tenants.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(tenantsService.list(input), input)));

  server.registerTool('chainapi_admin_get_tenant', {
    description: 'Get tenant details.',
    inputSchema: { tenantId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ tenantId }: any) => safeTool(() => ({ data: tenantsService.getById(tenantId) })));

  server.registerTool('chainapi_admin_update_tenant', {
    description: 'Update tenant profile/status.',
    inputSchema: {
      tenantId: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      status: z.enum(['active', 'suspended', 'disabled']).optional(),
      metadata,
    },
    annotations: write,
  }, async ({ tenantId, ...input }: any) => safeTool(() => ({ data: tenantsService.update(tenantId, input) })));

  server.registerTool('chainapi_admin_get_tenant_config', {
    description: 'Get tenant configuration.',
    inputSchema: { tenantId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ tenantId }: any) => safeTool(() => ({ data: tenantsService.getById(tenantId).config })));

  server.registerTool('chainapi_admin_update_tenant_config', {
    description: 'Update tenant configuration, including admin-only custody fields.',
    inputSchema: {
      tenantId: z.string().min(1),
      btcConfirmationsRequired: z.number().int().min(0).optional(),
      btcFinalityConfirmations: z.number().int().min(1).optional(),
      custodyMode: z.enum(['external_signer', 'platform_custody', 'hybrid_custody']).optional(),
      withdrawalMode: z.enum(['external_signer', 'automatic', 'manual_approval', 'threshold_based']).optional(),
      dailyWithdrawalLimitSats: z.string().nullable().optional(),
      perTxLimitSats: z.string().nullable().optional(),
      btcXpub: z.string().min(1).nullable().optional(),
      btcSweepThresholdSats: z.string().regex(/^\d+$/).optional(),
      customerSessionTtlSeconds: z.number().int().min(60).max(86400).optional(),
      btcHotAddress: z.string().min(1).optional(),
      btcColdAddress: z.string().min(1).optional(),
    },
    annotations: write,
  }, async ({ tenantId, ...input }: any) => safeTool(async () => ({ data: await tenantsService.updateConfig(tenantId, input) })));

  server.registerTool('chainapi_admin_create_tenant_api_key', {
    description: 'Create a tenant API key. The raw apiKey is returned once and must be treated as a secret.',
    inputSchema: { tenantId: z.string().min(1), name: z.string().min(1).max(200) },
    annotations: write,
  }, async ({ tenantId, name }: any) => safeTool(() => {
    const result = tenantsService.generateApiKey(tenantId, name);
    return {
      data: {
        keyId: result.keyId,
        apiKey: result.rawKey,
        tenantId,
        warning: 'Store this key securely. It will not be shown again.',
      },
    };
  }));

  // ---- Ticklers ----

  server.registerTool('chainapi_admin_list_ticklers', {
    description: 'List all audit log entries (ticklers) across all tenants, including global platform events.',
    inputSchema: {
      tenantId: z.string().optional(),
      category: z.string().optional(),
      subcategory: z.string().optional(),
      entity_id: z.string().optional(),
      actor_login: z.string().optional(),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
      ...paging,
    },
    annotations: readOnly,
  }, async ({ tenantId: tId, ...input }: any) => safeTool(() => {
    const result = ticklerService.list({ tenantId: tId ?? undefined, includeGlobal: true, ...input });
    return page(result, input);
  }));

  server.registerTool('chainapi_admin_list_tenant_ticklers', {
    description: 'List audit log entries (ticklers) for a specific tenant, optionally including global platform events for that tenant.',
    inputSchema: {
      tenantId: z.string().min(1),
      includeGlobal: z.boolean().optional(),
      category: z.string().optional(),
      subcategory: z.string().optional(),
      entity_id: z.string().optional(),
      actor_login: z.string().optional(),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
      ...paging,
    },
    annotations: readOnly,
  }, async ({ tenantId: tId, includeGlobal, ...input }: any) => safeTool(() => {
    const result = ticklerService.list({ tenantId: tId, includeGlobal: includeGlobal ?? false, ...input });
    return page(result, input);
  }));
}

