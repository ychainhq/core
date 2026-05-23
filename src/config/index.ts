import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  SQLITE_DB_PATH: z.string().default('./data/crypto-api.sqlite'),
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
  DEPOSIT_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  WEBHOOK_DELIVERY_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  TX_STATUS_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  SWEEP_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  CUSTOMER_SESSION_SECRET: z.string().min(32).default('change-me-in-production-min-32-chars!!'),
  CUSTOMER_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(100),
  WEBHOOK_AUTO_PAUSE_THRESHOLD: z.coerce.number().int().min(1).default(10),
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  WAL_CHECKPOINT_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  MCP_ADMIN_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  MCP_ALLOWED_ORIGINS: z.string().default('http://127.0.0.1,http://localhost'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
