import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Database: SQLite (dev/MVP) or PostgreSQL (enterprise)
  DB_TYPE: z.enum(['sqlite', 'postgres']).default('sqlite'),
  SQLITE_DB_PATH: z.string().default('./data/chain-api.db'),
  DATABASE_URL: z.string().optional(),  // postgres://user:pass@host:5432/dbname
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  BITCOIN_RPC_URL: z.string().url().default('http://127.0.0.1:8332'),
  BITCOIN_RPC_USER: z.string().default('bitcoin'),
  BITCOIN_RPC_PASSWORD: z.string().default('changeme'),
  BITCOIN_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  BITCOIN_RPC_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  BITCOIN_RPC_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  BITCOIN_CORE_PROVISIONING_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  BITCOIN_NETWORK: z.enum(['mainnet', 'testnet', 'regtest']).default('mainnet'),
  API_KEY: z.string().optional(),
  ADMIN_KEY: z.string().optional(),
  TENANT_NAME: z.string().default('Default Tenant'),
  BTC_DEFAULT_CONFIRMATIONS: z.coerce.number().int().min(0).default(1),
  BTC_FINALITY_CONFIRMATIONS: z.coerce.number().int().min(1).default(6),
  WORKERS_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  WEBHOOK_DELIVERY_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  TX_STATUS_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  SWEEP_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  CUSTOMER_SESSION_SECRET: z.string().min(32).default('change-me-in-production-min-32-chars!!'),
  CUSTOMER_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(100),
  SIGNER_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(600),
  WEBHOOK_AUTO_PAUSE_THRESHOLD: z.coerce.number().int().min(1).default(10),
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  MCP_ADMIN_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  MCP_ALLOWED_ORIGINS: z.string().default('http://127.0.0.1,http://localhost'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NODE_HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  // Ethereum chain adapter (optional — enable when ETH node is available)
  ETH_NODE_URL: z.string().url().optional(),
  ETH_NODE_AUTH: z.string().optional(),  // 'user:password' for basic auth
  // TRON chain adapter (local/self-hosted node only; no TronGrid)
  TRON_NODE_URL: z.string().url().optional(),
  TRON_SOLIDITY_NODE_URL: z.string().url().optional(),
  TRON_NETWORK: z.string().default('private'),
  TRON_USDT_CONTRACT_ADDRESS: z.string().optional(),
  TRON_DEFAULT_CONFIRMATIONS: z.coerce.number().int().min(0).default(1),
  TRON_FINALITY_CONFIRMATIONS: z.coerce.number().int().min(1).default(20),
  // Engine cluster (FAZA 4)
  CLUSTER_ENABLED: z.string().transform(v => v === 'true').default('false'),
  CLUSTER_PEER_URLS: z.string().optional(),  // comma-separated peer engine URLs
  CLUSTER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  CLUSTER_LEADER_TTL_MS: z.coerce.number().int().positive().default(30000),
  ENGINE_URL: z.string().url().optional(),  // this engine's public URL (for cluster)
  // External Signer & Withdrawal Batcher
  BATCH_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  BATCH_WORKER_MAX_BATCHES_PER_RUN: z.coerce.number().int().positive().default(25),
  BATCH_WORKER_MAX_BATCHES_PER_TENANT_PER_RUN: z.coerce.number().int().positive().default(5),
  BATCH_WORKER_MAX_RUN_MS: z.coerce.number().int().positive().default(25000),
  SIGNING_TASK_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SIGNING_TASK_EXPIRY_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  // UTXO locks
  UTXO_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  SWEEP_UTXO_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  // Bitcoin fee rate cache
  BTC_FEE_RATE_CACHE_TTL_MS: z.coerce.number().int().positive().default(30000),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
