import { config } from './config/index';
import { getDb, closeDb } from './db/sqlite';
import { runMigrations } from './db/migrate';
import { createApp } from './app';
import { startWorkers, stopWorkers } from './workers/index';
import { reconcileBtcWallets } from './workers/btc-wallet-reconciler';
import { logger } from './shared/logging/index';

async function main(): Promise<void> {
  logger.info('Chain API starting...', { version: '0.1.0-beta', env: process.env['NODE_ENV'] || 'development' });

  // Initialize database
  runMigrations();

  // Ensure BTC Core wallets exist and watched addresses are imported
  try {
    await reconcileBtcWallets();
  } catch (err) {
    logger.warn('BTC wallet reconciliation failed (non-fatal)', { error: String(err) });
  }

  // Create Express app
  const app = createApp();

  // Start HTTP server
  const server = app.listen(config.PORT, () => {
    logger.info(`Chain API listening`, { port: config.PORT, network: config.BITCOIN_NETWORK });
  });

  // Start background workers
  startWorkers();

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    server.close(() => {
      logger.info('HTTP server closed');
      stopWorkers();
      closeDb();
      logger.info('Shutdown complete');
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { message: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
