import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { textPrompt } from './response';

export function registerTenantPrompts(server: McpServer): void {
  server.registerPrompt('chainapi_create_customer_deposit_flow', {
    description: 'Guide an agent through creating a customer and generating a BTC deposit address.',
    argsSchema: { reference: z.string().optional() },
  }, async ({ reference }) => textPrompt(
    `Create or find a customer${reference ? ` with reference ${reference}` : ''}, generate a BTC deposit address with chainapi_create_customer_deposit_address, and return the address plus customer id. Do not expose tenant API keys or internal secrets.`
  ));

  server.registerPrompt('chainapi_investigate_payment_request', {
    description: 'Investigate payment request status, deposits, and QR payload.',
    argsSchema: { paymentRequestId: z.string().optional(), reference: z.string().optional() },
  }, async ({ paymentRequestId, reference }) => textPrompt(
    `Investigate payment request ${paymentRequestId ?? reference ?? '<provide id or reference>'}. Use read-only tools first: get/list payment request, related deposits, and QR payload. Summarize current status and next operational action.`
  ));

  server.registerPrompt('chainapi_prepare_btc_withdrawal_signing', {
    description: 'Guide an agent through a pending BTC withdrawal or sweep signing flow.',
    argsSchema: { withdrawalId: z.string().optional(), sweepId: z.string().optional() },
  }, async ({ withdrawalId, sweepId }) => textPrompt(
    `Inspect pending signing state for ${withdrawalId ? `withdrawal ${withdrawalId}` : sweepId ? `sweep ${sweepId}` : 'the provided withdrawal or sweep'}. The signer must sign outside MCP. MCP may only submit an already signed PSBT and verify status afterward.`
  ));

  server.registerPrompt('chainapi_customer_balance_report', {
    description: 'Produce a customer balance/deposit/address/withdrawal status report.',
    argsSchema: { customerId: z.string() },
  }, async ({ customerId }) => textPrompt(
    `Produce a concise report for customer ${customerId}. Use customer profile, balances, addresses, deposits, and withdrawals. Keep amounts as integer strings and do not infer on-chain ownership beyond chain-api records.`
  ));
}

