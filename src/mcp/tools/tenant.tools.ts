import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { requireTenant, McpAuthContext } from '../context';
import { safeTool } from '../errors';
import { tenantsService } from '../../modules/tenants/tenants.service';
import { customersService } from '../../modules/customers/customers.service';
import { depositAddressService } from '../../modules/customers/deposit-address.service';
import { chainsService } from '../../modules/chains/chains.service';
import { assetsService } from '../../modules/assets/assets.service';
import { walletsService } from '../../modules/wallets/wallets.service';
import { addressesService } from '../../modules/addresses/addresses.service';
import { paymentRequestsService } from '../../modules/payment-requests/payment-requests.service';
import { depositsService } from '../../modules/deposits/deposits.service';
import { withdrawalsService } from '../../modules/withdrawals/withdrawals.service';
import { sweepsService } from '../../modules/sweeps/sweeps.service';
import { webhooksService } from '../../modules/webhooks/webhooks.service';
import { adapterRegistry } from '../../chain-adapters/registry';
import { detectAddressType } from '../../shared/validation/bitcoin';
import { config } from '../../config/index';
import { issueCustomerToken } from '../../shared/customer-auth/jwt.service';
import { bitcoinTransactionsService } from '../../modules/bitcoin/bitcoin-transactions.service';
import { idempotencyService } from '../../modules/idempotency/idempotency.service';

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

export function registerTenantTools(server: McpServer, ctx: McpAuthContext): void {
  const tenant = requireTenant(ctx);
  const tenantId = tenant.tenantId;

  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, openWorldHint: false };
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  server.registerTool('chainapi_get_tenant', {
    description: 'Get the authenticated tenant profile.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: tenantsService.getById(tenantId) })));

  server.registerTool('chainapi_update_tenant', {
    description: 'Update the authenticated tenant profile. Does not allow status changes.',
    inputSchema: {
      name: z.string().min(1).max(200).optional(),
      metadata,
    },
    annotations: write,
  }, async (input: any) => safeTool(() => ({ data: tenantsService.update(tenantId, input) })));

  server.registerTool('chainapi_get_tenant_config', {
    description: 'Get the authenticated tenant configuration.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(() => ({ data: tenantsService.getById(tenantId).config })));

  server.registerTool('chainapi_update_tenant_config', {
    description: 'Update safe tenant configuration fields.',
    inputSchema: {
      btcConfirmationsRequired: z.number().int().min(0).optional(),
      btcFinalityConfirmations: z.number().int().min(1).optional(),
      withdrawalMode: z.enum(['external_signer', 'automatic', 'manual_approval', 'threshold_based']).optional(),
      dailyWithdrawalLimitSats: z.string().nullable().optional(),
      perTxLimitSats: z.string().nullable().optional(),
      btcXpub: z.string().min(1).nullable().optional(),
      btcSweepThresholdSats: z.string().regex(/^\d+$/).optional(),
      customerSessionTtlSeconds: z.number().int().min(60).max(86400).optional(),
    },
    annotations: write,
  }, async (input: any) => safeTool(async () => ({ data: await tenantsService.updateConfig(tenantId, input) })));

  server.registerTool('chainapi_list_chains', {
    description: 'List blockchain networks.',
    inputSchema: { enabled: z.boolean().optional(), type: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => ({ data: chainsService.list(input) })));

  server.registerTool('chainapi_get_chain', {
    description: 'Get blockchain network details.',
    inputSchema: { chain: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain }: any) => safeTool(() => ({ data: chainsService.getById(chain) })));

  server.registerTool('chainapi_list_assets', {
    description: 'List assets, optionally filtered by chain or type.',
    inputSchema: { chain: z.string().optional(), type: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => ({ data: assetsService.list(input) })));

  server.registerTool('chainapi_get_asset', {
    description: 'Get asset details for a chain and symbol.',
    inputSchema: { chain: z.string().min(1), asset: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, asset }: any) => safeTool(() => ({ data: assetsService.getByChainAndSymbol(chain, asset) })));

  server.registerTool('chainapi_create_customer', {
    description: 'Create a tenant-scoped customer.',
    inputSchema: { reference: z.string().min(1).max(200).optional(), metadata },
    annotations: write,
  }, async (input: any) => safeTool(() => ({ data: customersService.create(tenantId, input) })));

  server.registerTool('chainapi_list_customers', {
    description: 'List tenant customers.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(customersService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_customer', {
    description: 'Get customer details.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersService.getById(tenantId, customerId) })));

  server.registerTool('chainapi_update_customer', {
    description: 'Update a tenant customer.',
    inputSchema: {
      customerId: z.string().min(1),
      reference: z.string().min(1).max(200).optional(),
      status: z.enum(['active', 'disabled', 'frozen']).optional(),
      metadata,
    },
    annotations: write,
  }, async ({ customerId, ...input }: any) => safeTool(() => ({ data: customersService.update(tenantId, customerId, input) })));

  server.registerTool('chainapi_disable_customer', {
    description: 'Disable a tenant customer.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: destructive,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersService.disable(tenantId, customerId) })));

  server.registerTool('chainapi_get_customer_balances', {
    description: 'Get customer ledger balances.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ customerId }: any) => safeTool(() => ({ data: customersService.getBalances(tenantId, customerId) })));

  server.registerTool('chainapi_list_customer_deposits', {
    description: 'List deposits for a customer.',
    inputSchema: { customerId: z.string().min(1), ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async ({ customerId, ...input }: any) => safeTool(() => page(customersService.getDeposits(tenantId, customerId, input), input)));

  server.registerTool('chainapi_list_customer_addresses', {
    description: 'List deposit addresses for a customer.',
    inputSchema: { customerId: z.string().min(1), ...paging },
    annotations: readOnly,
  }, async ({ customerId, ...input }: any) => safeTool(() => page(customersService.getAddresses(tenantId, customerId, input), input)));

  server.registerTool('chainapi_create_customer_session', {
    description: 'Issue a short-lived customer session token.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: write,
  }, async ({ customerId }: any) => safeTool(() => {
    const customer = customersService.getById(tenantId, customerId);
    if (customer.status !== 'active') throw new Error(`Customer account is ${customer.status}`);
    const ttl = tenantsService.getById(tenantId).config?.customer_session_ttl_seconds ?? undefined;
    const { accessToken, expiresAt } = issueCustomerToken(tenantId, customer.id, ttl);
    return { data: { accessToken, expiresAt, customerId: customer.id } };
  }));

  server.registerTool('chainapi_create_customer_deposit_address', {
    description: 'Generate a new BTC deposit address for a customer.',
    inputSchema: { customerId: z.string().min(1) },
    annotations: write,
  }, async ({ customerId }: any) => safeTool(async () => {
    customersService.getById(tenantId, customerId);
    return { data: await depositAddressService.generateForCustomer(tenantId, customerId) };
  }));

  server.registerTool('chainapi_create_wallet', {
    description: 'Create a logical wallet.',
    inputSchema: {
      name: z.string().min(1).max(200),
      type: z.enum(['watch_only', 'external_signer']),
      walletRole: z.enum(['watch_only', 'tenant_hot', 'tenant_cold', 'customer_deposits', 'external_signer']).optional(),
      metadata,
    },
    annotations: write,
  }, async (input: any) => safeTool(() => ({ data: walletsService.create(tenantId, input) })));

  server.registerTool('chainapi_list_wallets', {
    description: 'List logical wallets.',
    inputSchema: { ...paging, type: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(walletsService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_wallet', {
    description: 'Get logical wallet details.',
    inputSchema: { walletId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ walletId }: any) => safeTool(() => ({ data: walletsService.getById(tenantId, walletId) })));

  server.registerTool('chainapi_register_wallet_address', {
    description: 'Register an address to a logical wallet and watch it.',
    inputSchema: {
      walletId: z.string().min(1),
      chain: z.string().min(1),
      address: z.string().min(1),
      label: z.string().max(200).optional(),
      addressType: z.string().optional(),
      addressRole: z.string().optional(),
      customerId: z.string().optional(),
      metadata,
    },
    annotations: write,
  }, async ({ walletId, ...input }: any) => safeTool(() => ({ data: addressesService.addToWallet(tenantId, walletId, input) })));

  server.registerTool('chainapi_list_wallet_addresses', {
    description: 'List addresses registered to a wallet.',
    inputSchema: { walletId: z.string().min(1), ...paging },
    annotations: readOnly,
  }, async ({ walletId, ...input }: any) => safeTool(() => page(addressesService.listByWallet(tenantId, walletId, input), input)));

  server.registerTool('chainapi_validate_address', {
    description: 'Validate an address for a chain. This is read-only even though REST uses POST.',
    inputSchema: { chain: z.string().min(1), address: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, address }: any) => safeTool(() => {
    const adapter = adapterRegistry.get(chain);
    const valid = adapter.isValidAddress(address);
    const format = chain === 'bitcoin' ? detectAddressType(address, config.BITCOIN_NETWORK) ?? undefined : undefined;
    return { data: { valid, address, chain, format } };
  }));

  server.registerTool('chainapi_get_wallet_balances', {
    description: 'Get on-chain balances for a wallet.',
    inputSchema: { walletId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ walletId }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getWalletBalances(tenantId, walletId) })));

  server.registerTool('chainapi_get_address_balances', {
    description: 'Get on-chain balances for an address.',
    inputSchema: { chain: z.string().min(1), address: z.string().min(1), asset: z.string().optional() },
    annotations: readOnly,
  }, async ({ chain, address, asset }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getAddressBalance(tenantId, chain, address, asset) })));

  server.registerTool('chainapi_list_address_utxos', {
    description: 'List BTC UTXOs for an address.',
    inputSchema: { address: z.string().min(1), minConfirmations: z.number().int().min(0).optional() },
    annotations: readOnly,
  }, async ({ address, minConfirmations }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getAddressUtxos(tenantId, address, minConfirmations ?? 0) })));

  server.registerTool('chainapi_list_wallet_utxos', {
    description: 'List BTC UTXOs for all active wallet addresses.',
    inputSchema: { walletId: z.string().min(1), minConfirmations: z.number().int().min(0).optional() },
    annotations: readOnly,
  }, async ({ walletId, minConfirmations }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getWalletUtxos(tenantId, walletId, minConfirmations ?? 0) })));

  server.registerTool('chainapi_get_bitcoin_fees', {
    description: 'Get BTC fee estimates.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => safeTool(async () => ({ data: await bitcoinTransactionsService.getFees() })));

  server.registerTool('chainapi_create_payment_request', {
    description: 'Create a payment request. Supports idempotencyKey.',
    inputSchema: {
      chain: z.string().min(1),
      asset: z.string().min(1),
      amount: z.string().min(1),
      walletId: z.string().optional(),
      address: z.string().optional(),
      customerId: z.string().optional(),
      reference: z.string().max(200).optional(),
      expiresAt: z.string().optional(),
      confirmationsRequired: z.number().int().min(0).max(100).optional(),
      metadata,
      idempotencyKey: z.string().optional(),
    },
    annotations: { ...write, idempotentHint: true },
  }, async ({ idempotencyKey, ...input }: any) => safeTool(() => {
    if (idempotencyKey) {
      const existing = idempotencyService.get(tenantId, idempotencyKey, 'payment_request');
      if (existing) return existing.result;
    }
    const paymentRequest = paymentRequestsService.create(tenantId, input);
    const result = { data: paymentRequest };
    if (idempotencyKey) idempotencyService.save(tenantId, idempotencyKey, 'payment_request', result, 201);
    return result;
  }));

  server.registerTool('chainapi_list_payment_requests', {
    description: 'List payment requests.',
    inputSchema: { ...paging, status: z.string().optional(), chain: z.string().optional(), reference: z.string().optional(), walletId: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(paymentRequestsService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_payment_request', {
    description: 'Get payment request details.',
    inputSchema: { paymentRequestId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ paymentRequestId }: any) => safeTool(() => ({ data: paymentRequestsService.getById(tenantId, paymentRequestId) })));

  server.registerTool('chainapi_get_payment_requests_by_reference', {
    description: 'Get payment requests by tenant reference.',
    inputSchema: { reference: z.string().min(1) },
    annotations: readOnly,
  }, async ({ reference }: any) => safeTool(() => ({ data: paymentRequestsService.getByReference(tenantId, reference) })));

  server.registerTool('chainapi_get_payment_request_qr', {
    description: 'Get BIP-21 QR payload for a payment request.',
    inputSchema: { paymentRequestId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ paymentRequestId }: any) => safeTool(() => {
    const pr = paymentRequestsService.getById(tenantId, paymentRequestId);
    return { data: { paymentRequestId: pr.id, format: 'payload', qrPayload: pr.qr_payload } };
  }));

  server.registerTool('chainapi_cancel_payment_request', {
    description: 'Cancel a payment request.',
    inputSchema: { paymentRequestId: z.string().min(1) },
    annotations: destructive,
  }, async ({ paymentRequestId }: any) => safeTool(() => ({ data: paymentRequestsService.cancel(tenantId, paymentRequestId) })));

  server.registerTool('chainapi_list_deposits', {
    description: 'List tenant deposits.',
    inputSchema: { ...paging, walletId: z.string().optional(), chain: z.string().optional(), status: z.string().optional(), address: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(depositsService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_deposit', {
    description: 'Get deposit details.',
    inputSchema: { depositId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ depositId }: any) => safeTool(() => ({ data: depositsService.getById(tenantId, depositId) })));

  server.registerTool('chainapi_list_address_deposits', {
    description: 'List deposits for a chain address.',
    inputSchema: { chain: z.string().min(1), address: z.string().min(1), ...paging, status: z.string().optional(), walletId: z.string().optional() },
    annotations: readOnly,
  }, async ({ chain, address, ...input }: any) => safeTool(() => page(depositsService.list(tenantId, { ...input, chain, address }), input)));

  server.registerTool('chainapi_list_withdrawals', {
    description: 'List tenant customer withdrawals.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(withdrawalsService.listForTenant(tenantId, input), input)));

  server.registerTool('chainapi_get_withdrawal', {
    description: 'Get withdrawal details.',
    inputSchema: { withdrawalId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ withdrawalId }: any) => safeTool(() => ({ data: withdrawalsService.getById(tenantId, withdrawalId) })));

  server.registerTool('chainapi_submit_signed_withdrawal', {
    description: 'Submit a signed PSBT for a pending withdrawal.',
    inputSchema: { withdrawalId: z.string().min(1), signedPsbt: z.string().min(1) },
    annotations: destructive,
  }, async ({ withdrawalId, signedPsbt }: any) => safeTool(async () => ({ data: await withdrawalsService.submitSigned(tenantId, withdrawalId, signedPsbt) })));

  server.registerTool('chainapi_list_sweeps', {
    description: 'List tenant sweeps.',
    inputSchema: { ...paging, status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(sweepsService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_sweep', {
    description: 'Get sweep details.',
    inputSchema: { sweepId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ sweepId }: any) => safeTool(() => ({ data: sweepsService.getById(tenantId, sweepId) })));

  server.registerTool('chainapi_submit_signed_sweep', {
    description: 'Submit a signed PSBT for a pending sweep.',
    inputSchema: { sweepId: z.string().min(1), signedPsbt: z.string().min(1) },
    annotations: destructive,
  }, async ({ sweepId, signedPsbt }: any) => safeTool(async () => ({ data: await sweepsService.submitSigned(tenantId, sweepId, signedPsbt) })));

  server.registerTool('chainapi_bitcoin_coin_selection', {
    description: 'Preview BTC coin selection. Read-only.',
    inputSchema: {
      fromAddresses: z.array(z.string().min(1)).min(1),
      outputs: z.array(z.object({ address: z.string().min(1), amount: z.string().regex(/^\d+$/) })).min(1),
      feeRate: z.number().positive(),
      changeAddress: z.string().min(1),
    },
    annotations: readOnly,
  }, async (input: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.coinSelection(tenantId, input) })));

  server.registerTool('chainapi_bitcoin_prepare_transaction', {
    description: 'Prepare an unsigned BTC transaction or PSBT.',
    inputSchema: {
      fromAddresses: z.array(z.string().min(1)).min(1),
      outputs: z.array(z.object({ address: z.string().min(1), amount: z.string().regex(/^\d+$/) })).min(1),
      changeAddress: z.string().min(1),
      feePolicy: z.object({ feeRate: z.number().positive().optional(), targetBlocks: z.number().int().min(1).optional() }).optional(),
      format: z.enum(['psbt', 'raw']).optional(),
      walletId: z.string().optional(),
    },
    annotations: write,
  }, async (input: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.prepare(tenantId, input) })));

  server.registerTool('chainapi_bitcoin_finalize_psbt', {
    description: 'Finalize a signed PSBT into a raw transaction.',
    inputSchema: { psbt: z.string().min(1) },
    annotations: write,
  }, async ({ psbt }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.finalizePsbt(psbt) })));

  server.registerTool('chainapi_validate_raw_transaction', {
    description: 'Validate raw transaction mempool acceptance without broadcasting.',
    inputSchema: { chain: z.string().min(1).default('bitcoin'), rawTransaction: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, rawTransaction }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.validateRaw(chain, rawTransaction) })));

  server.registerTool('chainapi_broadcast_raw_transaction', {
    description: 'Broadcast a raw transaction to the chain.',
    inputSchema: { chain: z.string().min(1).default('bitcoin'), rawTransaction: z.string().min(1), idempotencyKey: z.string().optional() },
    annotations: { ...destructive, idempotentHint: true },
  }, async ({ chain, rawTransaction, idempotencyKey }: any) => safeTool(async () => {
    if (idempotencyKey) {
      const existing = idempotencyService.get(tenantId, idempotencyKey, 'broadcast');
      if (existing) return existing.result;
    }
    const result = { data: await bitcoinTransactionsService.broadcast(tenantId, chain, rawTransaction) };
    if (idempotencyKey) idempotencyService.save(tenantId, idempotencyKey, 'broadcast', result, 200);
    return result;
  }));

  server.registerTool('chainapi_get_transaction', {
    description: 'Get transaction details from chain and local record.',
    inputSchema: { chain: z.string().min(1), txHash: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, txHash }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getTransaction(chain, txHash) })));

  server.registerTool('chainapi_get_transaction_status', {
    description: 'Get transaction status.',
    inputSchema: { chain: z.string().min(1), txHash: z.string().min(1) },
    annotations: readOnly,
  }, async ({ chain, txHash }: any) => safeTool(async () => ({ data: await bitcoinTransactionsService.getTransactionStatus(chain, txHash) })));

  server.registerTool('chainapi_list_webhooks', {
    description: 'List tenant webhooks. Does not return webhook secrets.',
    inputSchema: { ...paging, walletId: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(webhooksService.list(tenantId, input), input)));

  server.registerTool('chainapi_get_webhook', {
    description: 'Get tenant webhook details. Does not return webhook secret.',
    inputSchema: { webhookId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ webhookId }: any) => safeTool(() => ({ data: webhooksService.getById(tenantId, webhookId) })));

  server.registerTool('chainapi_list_webhook_deliveries', {
    description: 'List webhook delivery attempts.',
    inputSchema: { ...paging, webhookId: z.string().optional(), eventType: z.string().optional(), status: z.string().optional() },
    annotations: readOnly,
  }, async (input: any) => safeTool(() => page(webhooksService.listDeliveries(tenantId, input), input)));

  server.registerTool('chainapi_test_webhook', {
    description: 'Send a test event to a webhook URL.',
    inputSchema: { webhookId: z.string().min(1) },
    annotations: write,
  }, async ({ webhookId }: any) => safeTool(async () => ({ data: await webhooksService.test(tenantId, webhookId) })));

  server.registerTool('chainapi_retry_webhook_delivery', {
    description: 'Mark a webhook delivery for retry by the delivery worker.',
    inputSchema: { deliveryId: z.string().min(1) },
    annotations: write,
  }, async ({ deliveryId }: any) => safeTool(() => ({ data: webhooksService.retryDelivery(tenantId, deliveryId) })));
}

