// Runs before each test file via Jest setupFiles.
// Sets env vars BEFORE any module is imported, so config/index.ts picks them up.
// dotenv.config() does NOT override already-set env vars.

process.env['SQLITE_DB_PATH'] = ':memory:';
process.env['BITCOIN_RPC_URL'] = 'http://127.0.0.1:18332'; // unreachable — adapter errors are expected
process.env['BITCOIN_RPC_USER'] = 'test';
process.env['BITCOIN_RPC_PASSWORD'] = 'test';
process.env['BITCOIN_RPC_TIMEOUT_MS'] = '100';
process.env['BITCOIN_RPC_MAX_ATTEMPTS'] = '1';
process.env['BITCOIN_RPC_RETRY_DELAY_MS'] = '0';
process.env['BITCOIN_CORE_PROVISIONING_ENABLED'] = 'false';
process.env['BITCOIN_NETWORK'] = 'mainnet';
process.env['API_KEY'] = 'test_api_key_integration_secret';
process.env['ADMIN_KEY'] = 'test_admin_key_integration_secret';
process.env['WORKERS_ENABLED'] = 'false';
process.env['LOG_LEVEL'] = 'error';
process.env['RATE_LIMIT_PER_MIN'] = '10000'; // avoid rate-limit interference
process.env['BTC_DEFAULT_CONFIRMATIONS'] = '1';
process.env['BTC_FINALITY_CONFIRMATIONS'] = '6';
process.env['MCP_ADMIN_ENABLED'] = 'true';
process.env['MCP_ALLOWED_ORIGINS'] = 'http://127.0.0.1,http://localhost';
