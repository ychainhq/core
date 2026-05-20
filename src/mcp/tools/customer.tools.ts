import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { McpAuthContext, requireCustomer } from '../context';
import { safeTool } from '../errors';
import { customersService } from '../../modules/customers/customers.service';
import { depositAddressService } from '../../modules/customers/deposit-address.service';
import { withdrawalsService } from '../../modules/withdrawals/withdrawals.service';
import { NotFoundError } from '../../shared/errors/index';

const paging = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
};

function page<T>(result: { data: T[]; nextCursor: string | null }, input: { limit?: number; cursor?: string }) {
  return {
    data: result.data,
    pagination: { limit: input.limit ?? 20, cursor: input.cursor ?? null, nextCursor: result.nextCursor },
  };
}

export function registerCustomerTools(server: McpServer, ctx: McpAuthContext): void {
  const customer = requireCustomer(ctx);
  const { tenantId, customerId } = customer;
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, openWorldHint: false };

  server.registerTool('chainapi_me_get_profile', {
    description: 'Get the authenticated customer profile.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: customersService.getById(tenantId, customerId) })));

  server.registerTool('chainapi_me_get_balances', {
    description: 'Get the authenticated customer ledger balances.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: customersService.getBalances(tenantId, customerId) })));

  server.registerTool('chainapi_me_list_deposits', {
    description: 'List deposits for the authenticated customer.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(customersService.getDeposits(tenantId, customerId, input), input)));

  server.registerTool('chainapi_me_list_addresses', {
    description: 'List deposit addresses for the authenticated customer.',
    inputSchema: { ...paging },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(customersService.getAddresses(tenantId, customerId, input), input)));

  server.registerTool('chainapi_me_create_deposit_address', {
    description: 'Generate a new BTC deposit address for the authenticated customer.',
    inputSchema: {},
    annotations: write,
  }, async () => safeTool(async () => ({ data: await depositAddressService.generateForCustomer(tenantId, customerId) })));

  server.registerTool('chainapi_me_create_withdrawal', {
    description: 'Create a customer withdrawal request and signing payload.',
    inputSchema: {
      toAddress: z.string().min(1),
      amountSats: z.string().regex(/^\d+$/),
      idempotencyKey: z.string().optional(),
    },
    annotations: { ...write, idempotentHint: true },
  }, async (input: any) => safeTool(async () => ({ data: await withdrawalsService.create(tenantId, customerId, input) })));

  server.registerTool('chainapi_me_list_withdrawals', {
    description: 'List withdrawals for the authenticated customer.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(withdrawalsService.list(tenantId, customerId, input), input)));

  server.registerTool('chainapi_me_get_withdrawal', {
    description: 'Get a withdrawal for the authenticated customer.',
    inputSchema: { withdrawalId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ withdrawalId }: any) => safeTool(() => {
    const withdrawal = withdrawalsService.getById(tenantId, withdrawalId);
    if (withdrawal.customer_id !== customerId) {
      throw new NotFoundError('Withdrawal', withdrawalId);
    }
    return { data: withdrawal };
  }));
}
