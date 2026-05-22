import express, { Request, Response } from 'express';
import { authMiddleware } from './shared/auth/middleware';
import { adminAuthMiddleware } from './shared/admin-auth/middleware';
import { customerAuthMiddleware } from './shared/customer-auth/middleware';
import { actorTokenMiddleware } from './shared/actor-auth/middleware';
import { rateLimitMiddleware } from './shared/rate-limit/middleware';
import { errorHandler } from './shared/errors/index';

// Routers
import { chainsRouter } from './modules/chains/chains.router';
import { assetsRouter } from './modules/assets/assets.router';
import { walletsRouter } from './modules/wallets/wallets.router';
import { addressesRouter, validateAddressRouter } from './modules/addresses/addresses.router';
import { monitorsRouter } from './modules/monitors/monitors.router';
import { balancesRouter, walletBalancesRouter } from './modules/balances/balances.router';
import { utxosRouter, walletUtxosRouter } from './modules/bitcoin/utxos.router';
import { feesRouter } from './modules/bitcoin/fees.router';
import { prepareRouter } from './modules/bitcoin/prepare.router';
import { transactionsRouter } from './modules/transactions/transactions.router';
import { paymentRequestsRouter } from './modules/payment-requests/payment-requests.router';
import { depositsRouter, addressDepositsRouter } from './modules/deposits/deposits.router';
import { ledgerRouter } from './modules/ledger/ledger.router';
import { webhooksRouter, webhookDeliveriesRouter } from './modules/webhooks/webhooks.router';
import { tenantsAdminRouter } from './modules/tenants/tenants.router';
import { tenantSelfRouter } from './modules/tenants/tenant-self.router';
import { customersRouter } from './modules/customers/customers.router';
import { sweepsRouter } from './modules/sweeps/sweeps.router';
import { meRouter } from './modules/me/me.router';
import { withdrawalsRouter } from './modules/withdrawals/withdrawals.router';
import { assetsService } from './modules/assets/assets.service';
import { registerMcpRoutes } from './mcp/register';

export function createApp(): express.Application {
  const app = express();

  // Body parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Trust proxy for correct IP in rate limiting
  app.set('trust proxy', 1);

  // Health check (no auth required)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '0.1.0-beta',
      chain: 'bitcoin',
      timestamp: new Date().toISOString(),
    });
  });

  // ---- MCP routes (authenticated per endpoint) ----
  registerMcpRoutes(app);

  // ---- Admin routes (X-Admin-Key auth) ----
  app.use('/admin/v1', adminAuthMiddleware);
  app.use('/admin/v1/tenants', tenantsAdminRouter);

  // ---- Customer self-service — must be registered BEFORE the tenant authMiddleware
  //      so that customer JWTs are handled by customerAuthMiddleware, not rejected
  //      by the tenant API-key lookup. ----
  app.use('/v1/me', customerAuthMiddleware, rateLimitMiddleware, meRouter);

  // Apply tenant auth, actor token (optional RBAC), and rate limiting to all /v1/* routes
  app.use('/v1', authMiddleware);
  app.use('/v1', actorTokenMiddleware);
  app.use('/v1', rateLimitMiddleware);

  // ---- Tenant self-service ----
  app.use('/v1/tenant', tenantSelfRouter);

  // ---- Customers (tenant-scoped) ----
  app.use('/v1/customers', customersRouter);

  // ---- Chains ----
  app.use('/v1/chains', chainsRouter);

  // ---- Chain-specific assets ----
  // GET /v1/chains/:chain/assets/:asset
  app.get('/v1/chains/:chain/assets/:asset', (req: Request, res: Response, next) => {
    try {
      const asset = assetsService.getByChainAndSymbol(req.params['chain']!, req.params['asset']!);
      res.json({ data: asset });
    } catch (err) {
      next(err);
    }
  });

  // ---- Assets (global) ----
  app.use('/v1/assets', assetsRouter);

  // ---- Wallets ----
  app.use('/v1/wallets', walletsRouter);

  // ---- Wallet addresses ----
  app.use('/v1/wallets/:walletId/addresses', addressesRouter);

  // ---- Wallet balances ----
  app.use('/v1/wallets/:walletId/balances', walletBalancesRouter);

  // ---- Wallet UTXOs ----
  app.use('/v1/wallets/:walletId/utxos', walletUtxosRouter);

  // ---- Address validation ----
  app.use('/v1/chains/:chain/addresses/validate', validateAddressRouter);

  // ---- Bitcoin UTXOs for address ----
  app.use('/v1/chains/bitcoin/addresses/:address/utxos', utxosRouter);

  // ---- Bitcoin fees ----
  app.use('/v1/chains/bitcoin/fees', feesRouter);

  // ---- Bitcoin transaction prepare/finalize (order matters: before generic /broadcast) ----
  app.use('/v1/chains/bitcoin/transactions', prepareRouter);

  // ---- Generic transactions broadcast/validate/status ----
  app.use('/v1/chains/:chain/transactions', transactionsRouter);

  // ---- Address balances ----
  // Must be after /validate and /utxos to avoid conflicts
  app.use('/v1/chains/:chain/addresses/:address/balances', balancesRouter);

  // ---- Address deposits ----
  app.use('/v1/chains/:chain/addresses/:address/deposits', addressDepositsRouter);

  // ---- Monitors ----
  app.use('/v1/monitors', monitorsRouter);

  // ---- Payment requests ----
  app.use('/v1/payment-requests', paymentRequestsRouter);

  // ---- Deposits ----
  app.use('/v1/deposits', depositsRouter);

  // ---- Ledger ----
  app.use('/v1/ledger', ledgerRouter);

  // ---- Sweeps ----
  app.use('/v1/sweeps', sweepsRouter);

  // ---- Customer withdrawals (tenant-facing: list + submit-signed) ----
  app.use('/v1/withdrawals', withdrawalsRouter);

  // ---- Webhooks ----
  app.use('/v1/webhooks', webhooksRouter);
  app.use('/v1/webhook-deliveries', webhookDeliveriesRouter);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
      },
    });
  });

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
