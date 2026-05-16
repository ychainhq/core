import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  SQLITE_DB_PATH: z.string().default('./data/crypto-api.sqlite'),
  BITCOIN_RPC_URL: z.string().url().default('http://127.0.0.1:8332'),
  BITCOIN_RPC_USER: z.string().default('bitcoin'),
  BITCOIN_RPC_PASSWORD: z.string().default('changeme'),
  BITCOIN_RPC_WALLET: z.string().optional(),
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
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(100),
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
