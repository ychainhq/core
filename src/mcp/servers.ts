import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAuthContext } from './context';
import { registerTenantTools } from './tools/tenant.tools';
import { registerCustomerTools } from './tools/customer.tools';
import { registerAdminTools } from './tools/admin.tools';
import { registerCustomerResources, registerTenantResources } from './resources';
import { registerTenantPrompts } from './prompts';

export function createMcpServer(ctx: McpAuthContext): McpServer {
  const server = new McpServer({
    name: `chain-api-${ctx.kind}`,
    version: '0.1.0-beta',
  });

  if (ctx.kind === 'tenant') {
    registerTenantTools(server, ctx);
    registerTenantResources(server, ctx);
    registerTenantPrompts(server);
  } else if (ctx.kind === 'customer') {
    registerCustomerTools(server, ctx);
    registerCustomerResources(server, ctx);
  } else {
    registerAdminTools(server, ctx);
  }

  return server;
}

