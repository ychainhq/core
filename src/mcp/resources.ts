import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAuthContext } from './context';
import { jsonResource } from './response';
import { tenantsService } from '../modules/tenants/tenants.service';
import { chainsService } from '../modules/chains/chains.service';
import { assetsService } from '../modules/assets/assets.service';
import { customersService } from '../modules/customers/customers.service';
import { paymentRequestsService } from '../modules/payment-requests/payment-requests.service';
import { depositsService } from '../modules/deposits/deposits.service';
import { withdrawalsService } from '../modules/withdrawals/withdrawals.service';
import { sweepsService } from '../modules/sweeps/sweeps.service';

export function registerTenantResources(server: McpServer, ctx: Extract<McpAuthContext, { kind: 'tenant' }>): void {
  const tenantId = ctx.tenantId;

  server.registerResource('tenant-profile', 'chainapi://tenant/profile', {
    title: 'Tenant profile',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri.href, { data: tenantsService.getById(tenantId) }));

  server.registerResource('tenant-config', 'chainapi://tenant/config', {
    title: 'Tenant config',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri.href, { data: tenantsService.getById(tenantId).config }));

  server.registerResource('tenant-chains', 'chainapi://tenant/chains', {
    title: 'Chains',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri.href, { data: chainsService.list() }));

  server.registerResource('tenant-assets', 'chainapi://tenant/assets', {
    title: 'Assets',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri.href, { data: assetsService.list() }));

  server.registerResource('customer-summary', new ResourceTemplate('chainapi://customers/{customerId}/summary', { list: undefined }), {
    title: 'Customer summary',
    mimeType: 'application/json',
  }, async (uri, vars) => {
    const customerId = String(vars.customerId);
    return jsonResource(uri.href, {
      data: {
        customer: customersService.getById(tenantId, customerId),
        balances: customersService.getBalances(tenantId, customerId),
      },
    });
  });

  server.registerResource('customer-addresses', new ResourceTemplate('chainapi://customers/{customerId}/addresses', { list: undefined }), {
    title: 'Customer addresses',
    mimeType: 'application/json',
  }, async (uri, vars) => {
    const customerId = String(vars.customerId);
    return jsonResource(uri.href, { data: customersService.getAddresses(tenantId, customerId).data });
  });

  server.registerResource('payment-request', new ResourceTemplate('chainapi://payment-requests/{paymentRequestId}', { list: undefined }), {
    title: 'Payment request',
    mimeType: 'application/json',
  }, async (uri, vars) => jsonResource(uri.href, {
    data: paymentRequestsService.getById(tenantId, String(vars.paymentRequestId)),
  }));

  server.registerResource('deposit', new ResourceTemplate('chainapi://deposits/{depositId}', { list: undefined }), {
    title: 'Deposit',
    mimeType: 'application/json',
  }, async (uri, vars) => jsonResource(uri.href, {
    data: depositsService.getById(tenantId, String(vars.depositId)),
  }));

  server.registerResource('withdrawal', new ResourceTemplate('chainapi://withdrawals/{withdrawalId}', { list: undefined }), {
    title: 'Withdrawal',
    mimeType: 'application/json',
  }, async (uri, vars) => jsonResource(uri.href, {
    data: withdrawalsService.getById(tenantId, String(vars.withdrawalId)),
  }));

  server.registerResource('sweep', new ResourceTemplate('chainapi://sweeps/{sweepId}', { list: undefined }), {
    title: 'Sweep',
    mimeType: 'application/json',
  }, async (uri, vars) => jsonResource(uri.href, {
    data: sweepsService.getById(tenantId, String(vars.sweepId)),
  }));

  server.registerResource('tenant-tool-schema', 'chainapi://schemas/tenant-tools', {
    title: 'Tenant MCP tool scope',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri.href, {
    data: {
      auth: 'Authorization: Bearer <tenant_api_key>',
      tenantScoped: true,
      customerScoped: false,
    },
  }));
}

export function registerCustomerResources(server: McpServer, ctx: Extract<McpAuthContext, { kind: 'customer' }>): void {
  server.registerResource('customer-tool-schema', 'chainapi://schemas/customer-tools', {
    title: 'Customer MCP tool scope',
    mimeType: 'application/json',
  }, async (uri) => jsonResource(uri.href, {
    data: {
      auth: 'Authorization: Bearer <customer_session_jwt>',
      tenantId: ctx.tenantId,
      customerId: ctx.customerId,
      customerScoped: true,
    },
  }));
}

