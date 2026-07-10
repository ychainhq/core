# Chain API Engine

A production-grade REST API for building crypto payment processing, custodial banking, and programmatic money movement. Supports Bitcoin and TRON (TRX + USDT TRC-20), with an EVM chain adapter in progress.

**Key capabilities:** multi-tenant architecture, multi-chain address monitoring, deposit detection via dedicated block indexers, payment requests, PSBT/raw transaction preparation, dynamic fee estimation, UTXO management, batch withdrawal processing, external signer integration (OSS and Enterprise), actor-scoped RBAC, HMAC-signed webhooks, immutable audit ledger, MCP tool layer for AI agent integration.

---

## How it works

### Wallets and tenants

The engine operates on two wallet constructs:

- **LWallet** (Logical Wallet) — a wallet record in the chain-api database representing a business role. All `/v1/wallets` endpoints operate on LWallets. Roles: `customer_deposits`, `tenant_hot`, `tenant_cold`, `watch_only`.
- **Chain nodes** — registered Bitcoin Core or TRON FullNode instances. The engine connects to them for transaction preparation and broadcasting. It does not use named wallets (FWallets) in Bitcoin Core.

```
chain-api engine
  └── Tenant (API key owner)
        ├── LWallet: tenant_hot        ← operational hot wallet
        ├── LWallet: tenant_cold       ← cold storage
        └── Customer (ledger identity)
              ├── LWallet: customer_deposits  ← namespace for deposit addresses
              ├── LedgerAccount (per chain, per asset)
              └── TransactionHistory
```

### Deposit detection: chain_events

The engine does not poll chain nodes for deposits. Instead, dedicated block indexer processes run alongside the engine:

- **btc-indexer** — scans Bitcoin blocks, writes raw events to the `chain_events` table
- **tron-indexer** — scans TRON blocks and TRC-20 Transfer logs, writes to `chain_events`

The engine's `DepositEventProcessorWorker` reads `chain_events`, maps events to registered deposit addresses, creates deposit records, updates ledger accounts, fires webhooks, and records an immutable tickler audit entry. Each event is processed exactly once (UNIQUE constraint + `SELECT FOR UPDATE SKIP LOCKED`).

Indexers have no knowledge of tenants or business logic. They output only: address → on-chain event.

### External signing

The engine never holds private keys. It prepares unsigned payloads:

- **Bitcoin:** PSBT (Partially Signed Bitcoin Transaction)
- **TRON:** raw transaction `txID` + `raw_data_hex` from a TRON FullNode

A registered external signer polls for signing tasks, validates the payload locally, signs it, and submits the signed result. The engine validates, broadcasts, and records the audit trail.

Two signer editions exist: **Signer OSS** (open source, local keys) and **Signer Enterprise** (HashiCorp Vault Transit, AWS KMS, Azure Key Vault).

---

## Prerequisites

- **Node.js 20+**
- **PostgreSQL 16+** (production) — SQLite is used only in integration tests via `bootstrapApp()`
- **Bitcoin Core** (fully synced) — for Bitcoin transaction preparation and broadcasting
- **TRON FullNode** — for TRON transaction preparation and broadcasting
- **btc-indexer** — `packages/btc-indexer`, required for Bitcoin deposit detection
- **tron-indexer** — `packages/tron-indexer`, required for TRON deposit detection

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set DATABASE_URL, BITCOIN_RPC_URL, TRON_NODE_URL at minimum

# 3. Run database migrations
npm run db:migrate

# 4. Seed initial data (chains + assets + API key)
npm run db:seed
# Seed prints your API key if API_KEY is not set in .env

# 5. Start the server (development)
npm run dev

# 6. Or build and start in production
npm run build && npm start
```

---

## Configuration Reference

All configuration is loaded at startup from `.env` via `src/config/index.ts` (Zod-validated). Missing required values cause immediate `process.exit(1)` with a descriptive error.

### Server & Database

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `DB_TYPE` | `sqlite` | `sqlite` (tests only) or `postgres` (production) |
| `DATABASE_URL` | — | PostgreSQL connection string: `postgres://user:pass@host:5432/db` |
| `DB_POOL_MAX` | `20` | Max PostgreSQL pool connections |
| `DB_POOL_IDLE_TIMEOUT_MS` | `30000` | Pool idle connection timeout (ms) |
| `SQLITE_DB_PATH` | `./data/chain-api.db` | SQLite file path (ignored when `DB_TYPE=postgres`) |

### Bitcoin Core

| Variable | Default | Description |
|----------|---------|-------------|
| `BITCOIN_RPC_URL` | `http://127.0.0.1:8332` | Bitcoin Core JSON-RPC endpoint (fallback when `chain_nodes` table is empty) |
| `BITCOIN_RPC_USER` | `bitcoin` | RPC username |
| `BITCOIN_RPC_PASSWORD` | `changeme` | RPC password |
| `BITCOIN_RPC_TIMEOUT_MS` | `10000` | Per-request timeout (ms) |
| `BITCOIN_RPC_MAX_ATTEMPTS` | `3` | Retry count on transient failure |
| `BITCOIN_RPC_RETRY_DELAY_MS` | `1000` | Delay between retries (ms) |
| `BITCOIN_NETWORK` | `mainnet` | `mainnet` \| `testnet` \| `regtest` |
| `BTC_FEE_RATE_CACHE_TTL_MS` | `30000` | Fee rate cache TTL from Bitcoin Core (ms) |

### TRON

| Variable | Default | Description |
|----------|---------|-------------|
| `TRON_NODE_URL` | — | TRON FullNode HTTP API base URL (fallback when `chain_nodes` table has no TRON entries) |
| `TRON_USDT_CONTRACT_ADDRESS` | — | TRC-20 USDT contract address (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` on mainnet). When set, activates USDT support. |
| `TRON_SIGNER_FINGERPRINT` | — | Fingerprint of the external signer key for TRON withdrawals (`m/1/0` — hot wallet key) |
| `TRON_SIGNER_FINGERPRINT_HD` | — | Fingerprint of the external signer HD key for TRON sweeps (account xprv for `m/0/N` child derivation) |
| `TRON_DEFAULT_CONFIRMATIONS` | `20` | Platform-wide default confirmations for TRON deposits |

### Ethereum / EVM (in progress)

| Variable | Default | Description |
|----------|---------|-------------|
| `ETH_NODE_URL` | — | Ethereum node JSON-RPC URL. Activates `EthereumAdapter` when set. |
| `ETH_NODE_AUTH` | — | Basic auth for Ethereum node: `user:password` format |

### Seed / Initial Keys

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | — | Tenant API key (auto-generated by seed if empty, printed once) |
| `ADMIN_KEY` | — | Admin key (auto-generated by seed if empty, printed once) |
| `TENANT_NAME` | `Default Tenant` | Name of the default tenant created by seed |

### Deposit Confirmations (platform-wide defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `BTC_DEFAULT_CONFIRMATIONS` | `1` | Confirmations required for BTC deposit → `confirmed` |
| `BTC_FINALITY_CONFIRMATIONS` | `6` | Confirmations after which BTC deposit is considered final |

Per-tenant overrides live in `tenant_configs` — see [Per-tenant configuration](#per-tenant-configuration).

### Workers

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKERS_ENABLED` | `true` | `false` disables all background workers (useful in tests) |
| `WEBHOOK_DELIVERY_INTERVAL_MS` | `10000` | Webhook delivery worker interval (ms) |
| `TX_STATUS_INTERVAL_MS` | `60000` | Transaction status / sweep confirmation worker interval (ms) |
| `SWEEP_WORKER_INTERVAL_MS` | `300000` | BTC sweep creation worker interval (ms) |
| `TRON_SWEEP_WORKER_INTERVAL_MS` | `60000` | Legacy env var — `TronSweepWorker` now runs every 30 s (hardcoded). `TronSweepQueueFeeder` runs every 10 s. |
| `TRON_BALANCE_REFRESH_INTERVAL_MS` | `300000` | TRON balance safety-net refresh worker interval (ms) |
| `NODE_HEALTH_CHECK_INTERVAL_MS` | `30000` | Chain node health check worker interval (ms) |
| `WEBHOOK_AUTO_PAUSE_THRESHOLD` | `10` | Consecutive failures before webhook endpoint is paused |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `30` | How long to keep webhook delivery records |

### External Signer & Withdrawal Batcher

| Variable | Default | Description |
|----------|---------|-------------|
| `BATCH_WORKER_INTERVAL_MS` | `30000` | Withdrawal batcher worker interval (ms) |
| `BATCH_WORKER_MAX_BATCHES_PER_RUN` | `25` | Max batches built per worker tick |
| `BATCH_WORKER_MAX_BATCHES_PER_TENANT_PER_RUN` | `5` | Max batches per tenant per worker tick |
| `BATCH_WORKER_MAX_RUN_MS` | `25000` | Hard time limit per batcher run (ms) |
| `SIGNING_TASK_TTL_SECONDS` | `300` | Signing tasks expire after this many seconds |
| `SIGNING_TASK_EXPIRY_INTERVAL_MS` | `60000` | Signing task expiry worker interval (ms) |
| `SIGNER_RATE_LIMIT_PER_MIN` | `600` | Rate limit for signer protocol endpoints (tasks, heartbeat, claim, submit, reject) |

### UTXO Locks

| Variable | Default | Description |
|----------|---------|-------------|
| `UTXO_LOCK_TTL_SECONDS` | `900` | Withdrawal batch UTXO lock TTL — safety net for abandoned batches (15 min) |
| `SWEEP_UTXO_LOCK_TTL_SECONDS` | `604800` | Sweep UTXO lock TTL — safety net for stuck sweeps (7 days) |

### Security & Auth

| Variable | Default | Description |
|----------|---------|-------------|
| `CUSTOMER_SESSION_SECRET` | `change-me-...` | HMAC-SHA256 secret for customer JWT tokens. **Min 32 chars.** Generate: `openssl rand -hex 32` |
| `CUSTOMER_SESSION_TTL_SECONDS` | `3600` | Customer session expiry (1 hour) |
| `RATE_LIMIT_PER_MIN` | `100` | API requests per minute per API key |

### MCP

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_ADMIN_ENABLED` | `false` | Enable admin MCP endpoint (`POST /mcp/admin`) |
| `MCP_ALLOWED_ORIGINS` | `http://127.0.0.1,http://localhost` | Comma-separated allowed CORS origins for MCP endpoints |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

### Engine Cluster HA

| Variable | Default | Description |
|----------|---------|-------------|
| `CLUSTER_ENABLED` | `false` | Enable cluster mode (active-active workers, leader election) |
| `ENGINE_URL` | — | This engine's public URL — used for cluster peer registration |
| `CLUSTER_PEER_URLS` | — | Comma-separated peer engine URLs |
| `CLUSTER_HEARTBEAT_INTERVAL_MS` | `10000` | Heartbeat to peer engines (ms) |
| `CLUSTER_LEADER_TTL_MS` | `30000` | Leader lease TTL — leader must renew within this window |

---

### Per-tenant configuration

Per-tenant settings are stored in `tenant_configs` and managed via API. They override platform-wide env var defaults for each tenant individually.

| DB column | API field | Description |
|-----------|-----------|-------------|
| `btc_confirmations_required` | `btcConfirmationsRequired` | Confirmations for BTC deposit → `confirmed` |
| `btc_finality_confirmations` | `btcFinalityConfirmations` | BTC finality threshold (no reorg risk) |
| `btc_fee_target_blocks` | `btcFeeTargetBlocks` | Fee estimation target blocks for BTC sweeps |
| `tron_confirmations_required` | `tronConfirmationsRequired` | Confirmations for TRON deposit → `confirmed` |
| `tron_usdt_sweep_threshold_sun` | `tronUsdtSweepThresholdSun` | Min USDT balance (in sun) that triggers USDT sweep |
| `tron_trx_sweep_threshold_sun` | `tronTrxSweepThresholdSun` | Min TRX balance (in sun) that triggers TRX sweep |
| `tron_staked_energy_sun` | `tronStakedEnergySun` | TRX (in sun) to delegate as ENERGY before each USDT sweep (Stake 2.0). `null` = no delegation. |
| `tron_sweep_threshold_sun` | `tronSweepThresholdSun` | **Deprecated** — USDT fallback only, overridden by `tron_usdt_sweep_threshold_sun`. Will be removed in a future migration. |
| `tron_usdt_contract_address` | — | Per-tenant USDT contract override (optional) |
| `custody_mode` | `custodyMode` | Custody model for this tenant |
| `withdrawal_mode` | `withdrawalMode` | Withdrawal flow: `auto` or `manual` |
| `daily_withdrawal_limit_sats` | `dailyWithdrawalLimitSats` | Daily BTC withdrawal cap (satoshis as string) |
| `per_tx_limit_sats` | `perTxLimitSats` | Per-transaction BTC cap (satoshis as string) |
| `actor_token_secret` | `actorTokenSecret` | Secret for X-Actor-Token JWT verification (min 32 chars) |

**Endpoints:**

```bash
GET  /admin/v1/tenants/:tenantId/config
PATCH /admin/v1/tenants/:tenantId/config

GET  /v1/tenant/config
PATCH /v1/tenant/config
```

### Per-tenant withdrawal batch configuration

Stored in `tenant_withdrawal_batch_configs`, managed via:

```bash
GET  /v1/tenant/withdrawal-batch-config
PATCH /v1/tenant/withdrawal-batch-config
```

**Bitcoin:**

| DB column | Description |
|-----------|-------------|
| `btc_target_blocks` | Fee estimation target blocks for BTC batches (default: `6`) |
| `btc_fee_policy` | Fee policy: `target_blocks` \| `fixed` |
| `btc_max_fee_rate_sat_vb` | Cap on fee rate (sat/vbyte) |
| `btc_min_fee_rate_sat_vb` | Floor on fee rate (sat/vbyte) |
| `btc_min_outputs_per_batch` | Minimum outputs to trigger batch creation (default: `1`) |
| `btc_max_outputs_per_batch` | Maximum outputs per single batch |
| `btc_max_batch_age_seconds` | Oldest queued withdrawal age that triggers batch creation |

**TRON:**

| DB column | Description |
|-----------|-------------|
| `tron_usdt_withdrawal_fee` | Fixed USDT fee per withdrawal (micro-USDT as TEXT, `'0'` = tenant_pays) |
| `withdrawal_fee_coverage` | Fee coverage mode: `tenant_pays` \| `sender_pays` \| `recipient_pays` |

---

## Bitcoin Core Setup

Add to your `bitcoin.conf`:

```ini
server=1
rpcuser=bitcoin
rpcpassword=changeme
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
txindex=1
```

The engine uses Bitcoin Core in **stateless mode** — no named wallets (FWallets), no `importaddress`, no `listunspent`. Transaction preparation uses `createpsbt` + `utxoupdatepsbt`. Broadcasting uses `sendrawtransaction`. Deposit monitoring is handled by btc-indexer.

Register Bitcoin Core nodes via the admin API after startup:

```bash
curl -X POST /admin/v1/chain-nodes \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{
    "chainId": "bitcoin",
    "url": "http://127.0.0.1:8332",
    "rpcUser": "bitcoin",
    "rpcPasswordRef": "env:BITCOIN_RPC_PASSWORD",
    "role": "full"
  }'
```

Multiple nodes can be registered per chain. The engine selects nodes with dynamic failover (TTL-cached health, skip unhealthy nodes).

---

## TRON Node Setup

The engine connects to a self-hosted TRON FullNode over its HTTP API. **No TronGrid or third-party hosted indexers** — the tron-indexer package connects to the same node.

Register TRON nodes via the admin API:

```bash
curl -X POST /admin/v1/chain-nodes \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{
    "chainId": "tron",
    "url": "http://127.0.0.1:8090",
    "role": "full"
  }'
```

Set the USDT contract address in `.env`:

```bash
# Mainnet
TRON_USDT_CONTRACT_ADDRESS=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
```

---

## TRON Sweep Configuration

Sweeps consolidate TRON deposit balances into the tenant hot wallet. The engine uses an event-driven queue — only addresses above threshold are ever queued, so the system stays O(active addresses) regardless of total customer count.

### Per-tenant parameters

Configure via `PATCH /v1/tenant/config` or `PATCH /admin/v1/tenants/:id/config`:

| Field | Description |
|-------|-------------|
| `tronUsdtSweepThresholdSun` | Min USDT balance (in sun) to trigger a USDT sweep. Example: `"1000000"` = 1 USDT. |
| `tronTrxSweepThresholdSun` | Min TRX balance (in sun) to trigger a TRX sweep. Example: `"10000000"` = 10 TRX. |
| `tronStakedEnergySun` | TRX (in sun) to stake as ENERGY before each USDT sweep (Stake 2.0). Set to `null` to disable. Example: `"100000000"` = 100 TRX. |

Example:

```bash
curl -X PATCH /v1/tenant/config \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tronUsdtSweepThresholdSun": "1000000",
    "tronTrxSweepThresholdSun": "10000000",
    "tronStakedEnergySun": "100000000"
  }'
```

### How sweeps work

1. **Queue feeder (every 10 s)** — reads `tron_account_balances`, computes priority for each address above threshold (normal ≥1×, high ≥2×, urgent ≥10×), upserts into `tron_sweep_queue`. Runs with a cap of 500 addresses per tick to prevent runaway scans.

2. **Sweep worker (every 30 s)** — claims up to 20 entries from `tron_sweep_queue` using a `DELETE ... RETURNING` pattern (no double-processing). Routes each entry:
   - **`tron:USDT`** → optionally delegates energy (if `tronStakedEnergySun` is set) → creates a `tron_sweep` signing task
   - **`tron:TRX`** → creates a `tron_trx_sweep` signing task

3. **Signer** — the external signer picks up the task, derives the child HD key (`m/0/N`), signs the `txID`, and submits the signed transaction.

4. **Energy reclaim (every 6 h)** — scans `tron_energy_delegations` for completed or aged-out delegations and issues `tron_undelegate_energy` tasks to return staked ENERGY to the hot wallet.

### Stake 2.0 energy delegation

USDT TRC-20 transfers cost ~30 000 energy. Without delegation, each deposit address needs to hold enough TRX for bandwidth/energy — operationally expensive at scale.

With `tronStakedEnergySun` configured, the hot wallet delegates `N` sun of ENERGY to the deposit address immediately before the sweep. The delegation uses `lock=false` (non-locking), so it can be reclaimed the same block the sweep confirms.

The delegated amount is tracked in `tron_energy_delegations`. The `TronEnergyReclaimWorker` undelegates after the sweep is confirmed, or after 24 hours as a safety timeout.

---

## API Authentication

All `/v1/...` endpoints require:
```
Authorization: Bearer <your-api-key>
```

Admin endpoints (`/admin/v1/...`) require:
```
X-Admin-Key: <admin-key>
```

Customer self-service endpoints (`/v1/me/...`) require a customer session JWT:
```
Authorization: Bearer <customer-session-jwt>
```

The `/health` endpoint is public.

---

## X-Actor-Token (RBAC)

Tenant API endpoints optionally accept `X-Actor-Token` for fine-grained, actor-scoped access control. Without it, full tenant-admin access applies.

```
X-Actor-Token: <jwt-hs256>
```

JWT payload:
```json
{
  "sub": "user_123",
  "tenant_id": "tenant_abc",
  "permissions": ["customers:read:team", "customers:write:assigned"],
  "teams": ["team_warsaw"],
  "exp": 1716394800
}
```

Permission format: `<entity>:<action>:<level>` — levels are `all`, `team`, `assigned`. Token secret is configured per tenant via `PATCH /v1/tenant/config { "actorTokenSecret": "..." }`.

---

## MCP Endpoints

The engine exposes MCP over Streamable HTTP with the same auth and tenant isolation as REST:

```bash
POST /mcp/tenant        # Authorization: Bearer <tenant-api-key>
POST /mcp/customer      # Authorization: Bearer <customer-session-jwt>
POST /mcp/admin         # X-Admin-Key: <admin-key>
```

Enable admin MCP: `MCP_ADMIN_ENABLED=true`

---

## Endpoints Reference

### Health

```bash
GET /health
```

### Admin: Tenant Management

```bash
POST   /admin/v1/tenants
GET    /admin/v1/tenants
GET    /admin/v1/tenants/:tenantId
PATCH  /admin/v1/tenants/:tenantId
GET    /admin/v1/tenants/:tenantId/config
PATCH  /admin/v1/tenants/:tenantId/config
POST   /admin/v1/tenants/:tenantId/api-keys
POST   /admin/v1/tenants/:tenantId/disable
```

Create tenant example:

```bash
curl -X POST /admin/v1/tenants \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Fintech",
    "assets": [
      { "chain": "bitcoin", "hotAddress": "bc1q..." },
      { "chain": "tron", "hotAddress": "TXxx..." }
    ],
    "tronXpub": "xpub...",
    "tronConfirmationsRequired": 20
  }'
```

### Chains & Assets

```bash
GET /v1/chains
GET /v1/chains/:chain
GET /v1/assets
GET /v1/chains/:chain/assets/:asset
```

### Wallets

```bash
POST /v1/wallets
GET  /v1/wallets
GET  /v1/wallets/:walletId
```

### Addresses

```bash
POST   /v1/chains/:chain/addresses/validate
GET    /v1/addresses/resolve
POST   /v1/wallets/:walletId/addresses
GET    /v1/wallets/:walletId/addresses
POST   /v1/monitors/addresses
GET    /v1/monitors/addresses
DELETE /v1/monitors/addresses/:monitorId
```

### Balances

```bash
GET  /v1/chains/:chain/addresses/:address/balances
GET  /v1/chains/:chain/addresses/:address/balances/:asset
GET  /v1/wallets/:walletId/balances
POST /v1/chains/tron/addresses/:address/balance-refresh   # fire-and-forget, 202
```

TRON balances are served from SQL cache (`tron_account_balances`) populated by tron-indexer — O(1) read regardless of wallet size. Responses include `stale: true` if cache is older than 10 minutes.

### Fees

```bash
GET /v1/chains/bitcoin/fees     # sat/vbyte estimate from Bitcoin Core
GET /v1/chains/tron/fees        # bandwidth points, energy estimate, USDT fee config
```

TRON fee estimation covers: bandwidth points (free tier + cost), energy (amount × price × 1.5 safety cap for `fee_limit`), and the tenant's configured USDT withdrawal fee.

### UTXOs (Bitcoin)

```bash
GET /v1/chains/bitcoin/addresses/:address/utxos?minConfirmations=1
GET /v1/wallets/:walletId/utxos
```

### Transaction Preparation & Broadcast

**Bitcoin:**

```bash
POST /v1/chains/bitcoin/transactions/coin-selection
POST /v1/chains/bitcoin/transactions/prepare       # returns PSBT
POST /v1/chains/bitcoin/transactions/finalize      # accepts signed PSBT
POST /v1/chains/bitcoin/transactions/broadcast     # idempotent
POST /v1/chains/bitcoin/transactions/validate
GET  /v1/chains/bitcoin/transactions/:txHash
GET  /v1/chains/bitcoin/transactions/:txHash/status
```

**Generic (TRON + future chains):**

```bash
POST /v1/chains/:chain/transactions/broadcast
POST /v1/chains/:chain/transactions/validate
GET  /v1/chains/:chain/transactions/:txHash
GET  /v1/chains/:chain/transactions/:txHash/status
```

### Payment Requests

```bash
POST /v1/payment-requests
GET  /v1/payment-requests
GET  /v1/payment-requests/:paymentRequestId
POST /v1/payment-requests/:paymentRequestId/cancel
GET  /v1/payment-requests/by-reference/:reference
GET  /v1/payment-requests/:paymentRequestId/qr
```

### Deposits

```bash
GET /v1/deposits
GET /v1/deposits/:depositId
GET /v1/chains/:chain/addresses/:address/deposits
```

Deposit statuses: `detected` → `confirmed`. No `pending_confirmation`. Per-tenant confirmation threshold via `btcConfirmationsRequired` / `tronConfirmationsRequired`.

### Customers

```bash
POST   /v1/customers
GET    /v1/customers
GET    /v1/customers/:customerId
PATCH  /v1/customers/:customerId
POST   /v1/customers/:customerId/disable
GET    /v1/customers/:customerId/balances
GET    /v1/customers/:customerId/deposits
GET    /v1/customers/:customerId/addresses
POST   /v1/customers/:customerId/sessions
POST   /v1/customers/:customerId/deposit-address   # ?chain=bitcoin|tron
GET    /v1/customers/:customerId/profile
PUT    /v1/customers/:customerId/profile
GET    /v1/customers/:customerId/identifiers
POST   /v1/customers/:customerId/identifiers
PATCH  /v1/customers/:customerId/identifiers/:identifierId
DELETE /v1/customers/:customerId/identifiers/:identifierId
GET    /v1/customers/:customerId/aml-kyc
PUT    /v1/customers/:customerId/aml-kyc
GET    /v1/customers/:customerId/data-governance
PUT    /v1/customers/:customerId/data-governance
GET    /v1/customers/:customerId/contact
PUT    /v1/customers/:customerId/contact
GET    /v1/customers/:customerId/documents
POST   /v1/customers/:customerId/documents
PATCH  /v1/customers/:customerId/documents/:documentId
DELETE /v1/customers/:customerId/documents/:documentId
```

TRON deposit addresses are generated via HD derivation from the tenant's `tron_xpub` (BIP44 `m/44'/195'/0'`, child path `m/0/{index}`). One address covers both TRX and USDT.

### Customer Self-Service (`/v1/me`)

```bash
GET  /v1/me
GET  /v1/me/tenant-config          # availableChains, availableAssets — safe subset for customer
GET  /v1/me/balances
GET  /v1/me/deposits
GET  /v1/me/addresses
GET  /v1/me/addresses/resolve
POST /v1/me/deposit-address        # chain=bitcoin|tron
POST /v1/me/withdrawals            # chainId, assetId, amountSats, toAddress
GET  /v1/me/withdrawals
GET  /v1/me/withdrawals/:withdrawalId
GET  /v1/me/profile
PUT  /v1/me/profile
GET  /v1/me/kyc-status
GET  /v1/me/contact
PUT  /v1/me/contact
GET  /v1/me/documents
POST /v1/me/documents
```

### Withdrawals

```bash
GET  /v1/withdrawals
GET  /v1/withdrawals/:withdrawalId
POST /v1/withdrawals/:withdrawalId/submit-signed
```

Customer withdrawals flow: `created → batched → pending_signature → broadcast → confirmed`.

The withdrawal batcher builds signed task payloads per chain:
- **Bitcoin:** PSBT batch (N outputs, coin selection, fee estimation)
- **TRON:** one raw transaction per withdrawal (`triggersmartcontract` for USDT, `createtransaction` for TRX)

TRON USDT withdrawal fee coverage modes: `tenant_pays`, `sender_pays`, `recipient_pays`.

### Withdrawal Batches

```bash
GET  /v1/withdrawal-batches
GET  /v1/withdrawal-batches/:batchId
POST /v1/withdrawal-batches/:batchId/approve
POST /v1/withdrawal-batches/:batchId/reject
POST /v1/withdrawal-batches/:batchId/cancel
POST /v1/withdrawal-batches/:batchId/retry
POST /v1/withdrawal-batches/:batchId/rbf-bump    # Bitcoin only — RBF fee bump
POST /v1/withdrawal-batches/:batchId/cpfp        # Bitcoin only — CPFP child tx
GET  /v1/tenant/withdrawal-batch-config
PATCH /v1/tenant/withdrawal-batch-config
```

### External Signers

```bash
POST   /v1/external-signers/enroll
GET    /v1/external-signers
GET    /v1/external-signers/policies
PUT    /v1/external-signers/policies
GET    /v1/external-signers/:signerId
PATCH  /v1/external-signers/:signerId
POST   /v1/external-signers/:signerId/enable
POST   /v1/external-signers/:signerId/disable
DELETE /v1/external-signers/:signerId
POST   /v1/external-signers/:signerId/heartbeat
GET    /v1/external-signers/:signerId/tasks
POST   /v1/external-signers/:signerId/tasks/:taskId/claim
POST   /v1/external-signers/:signerId/tasks/:taskId/submit
POST   /v1/external-signers/:signerId/tasks/:taskId/reject
```

**Signing task types:**

| Type | Chain | Payload format | Key | Signer action |
|------|-------|----------------|-----|---------------|
| `btc_psbt` | Bitcoin | Base64 PSBT | withdrawal key | Finalize and sign PSBT |
| `tron_withdrawal` | TRON | `tron_raw_tx` | hot wallet key | Sign txID → 65-byte recoverable sig |
| `tron_sweep` | TRON | `tron_raw_tx` + `derivationPath` | HD xprv `m/0/N` | Derive child key, sign txID (USDT TRC-20) |
| `tron_trx_sweep` | TRON | `tron_raw_tx` + `derivationPath` | HD xprv `m/0/N` | Derive child key, sign txID (native TRX) |
| `tron_delegate_energy` | TRON | `tron_raw_tx` | hot wallet key | Sign delegation tx — pre-sweep Stake 2.0 |
| `tron_undelegate_energy` | TRON | `tron_raw_tx` | hot wallet key | Sign undelegation tx — post-sweep reclaim |
| `tron_raw_tx` | TRON | `tron_raw_tx` | hot wallet key | Generic TRON sign |

Each signer daemon should have its own dedicated API key to avoid shared rate limit buckets. The signer protocol endpoints use `SIGNER_RATE_LIMIT_PER_MIN` (default 600/min) — separate from the standard API limit.

### Signing Tasks

```bash
GET  /v1/signing-tasks
GET  /v1/signing-tasks/:taskId
POST /v1/signing-tasks/:taskId/approve
POST /v1/signing-tasks/:taskId/reject
```

### Sweeps

Sweeps consolidate balances from deposit addresses into the tenant hot wallet. Created automatically — no `POST /v1/sweeps` endpoint.

```bash
GET  /v1/sweeps/summary?chainId=bitcoin&assetId=bitcoin:BTC
GET  /v1/sweeps/summary?chainId=tron&assetId=tron:USDT
GET  /v1/sweeps/summary?chainId=tron&assetId=tron:TRX
GET  /v1/sweeps
GET  /v1/sweeps?chainId=tron&assetId=tron:USDT
GET  /v1/sweeps/:sweepId
POST /v1/sweeps/:sweepId/submit-signed
```

`summary` returns `threshold_raw`, `current_total_raw`, `pending_sweep_id`, and `total_utxos` (Bitcoin only; `null` for TRON). Default parameters: `chainId=bitcoin`, `assetId=bitcoin:BTC`.

#### TRON sweep architecture

TRON sweeps use an event-driven queue to stay O(active) — only deposit addresses with balance above threshold enter the queue:

```
TronSweepQueueFeeder (every 10 s)
  Reads tron_account_balances (LIMIT 500 per run)
  Computes priority per address:
    ≥ 10× threshold → urgent (2)
    ≥  2× threshold → high   (1)
    ≥  1× threshold → normal (0)
  Upserts into tron_sweep_queue (ON CONFLICT DO UPDATE — idempotent)

TronSweepWorker (every 30 s)
  DELETE-claims up to 20 entries from tron_sweep_queue (highest priority first)
  tron:USDT → [optional: delegate energy] → create tron_sweep signing task
  tron:TRX  → create tron_trx_sweep signing task

TronEnergyReclaimWorker (every 6 h)
  Reclaims Stake 2.0 delegations where:
    - linked sweep is confirmed, OR
    - delegation is older than 24 h, OR
    - linked sweep failed
  Creates tron_undelegate_energy signing task per delegation
```

**Stake 2.0 energy delegation** — when `tron_staked_energy_sun` is configured, the engine delegates that amount of ENERGY from the hot wallet to the deposit address before the USDT sweep. This eliminates the need to prefund every deposit address with TRX for gas. Delegations are non-locking (`lock=false`) — reclaimed by `TronEnergyReclaimWorker` after the sweep confirms.

#### Admin: TRON sweep stats

```bash
GET /admin/v1/tron/sweep-queue-stats
# X-Admin-Key: <admin-key>
```

Returns current queue depth (total + by asset + by priority) and active energy delegations count.

### Ledger

```bash
POST /v1/ledger/accounts
GET  /v1/ledger/accounts
GET  /v1/ledger/accounts/:ledgerAccountId
GET  /v1/ledger/accounts/:ledgerAccountId/balances
GET  /v1/ledger/accounts/:ledgerAccountId/entries
POST /v1/ledger/transfers            # idempotent internal transfer
```

### Webhooks

```bash
POST   /v1/webhooks
GET    /v1/webhooks
GET    /v1/webhooks/:webhookId
PATCH  /v1/webhooks/:webhookId
DELETE /v1/webhooks/:webhookId
POST   /v1/webhooks/:webhookId/test
GET    /v1/webhook-deliveries
POST   /v1/webhook-deliveries/:deliveryId/retry
```

### Ticklers (Audit Log)

```bash
GET /v1/ticklers
GET /admin/v1/ticklers
GET /admin/v1/tenants/:tenantId/ticklers
```

The tickler table is write-once (append-only). Every financial state transition creates a tickler record. Records are never modified or deleted.

### Chain Nodes

```bash
POST  /admin/v1/chain-nodes
GET   /admin/v1/chain-nodes
GET   /admin/v1/chain-nodes/:nodeId
PATCH /admin/v1/chain-nodes/:nodeId
POST  /admin/v1/chain-nodes/:nodeId/test-connection

POST  /v1/chain-nodes
GET   /v1/chain-nodes
GET   /v1/chain-nodes/:nodeId
PATCH /v1/chain-nodes/:nodeId
DELETE /v1/chain-nodes/:nodeId
POST  /v1/chain-nodes/:nodeId/set-primary
POST  /v1/chain-nodes/:nodeId/test-connection
```

### Engine Cluster HA

```bash
GET  /admin/v1/cluster/status
POST /internal/cluster/heartbeat
POST /internal/cluster/claim-leadership
```

---

## Webhook Signature Verification

Each webhook delivery includes:
- `X-CryptoApi-Event-Id`: `evt_<uuid>`
- `X-CryptoApi-Timestamp`: Unix timestamp in milliseconds
- `X-CryptoApi-Signature`: HMAC-SHA256 hex signature

Verification (Node.js):

```javascript
const crypto = require('crypto');

function verifyWebhook(secret, timestamp, body, signature) {
  const message = `${timestamp}.${JSON.stringify(body)}`;
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

---

## Idempotency

POST endpoints that create resources support the `Idempotency-Key` header. Results are cached for 24 hours. Sending the same key returns the original response without re-executing.

```
Idempotency-Key: <unique-key>
```

Supported: payment requests, transaction broadcasts, ledger transfers.

---

## Architecture

```
Express API (src/app.ts)
    ├── Auth middleware (API key SHA-256 hash lookup, customer session JWT, admin key)
    ├── Actor-auth middleware (X-Actor-Token RBAC)
    ├── Rate limit middleware
    └── Routes /v1/* /admin/v1/* /mcp/* /internal/*

Services
    ├── Business logic (customers, deposits, withdrawals, ledger, sweeps...)
    ├── Chain Adapters
    │   ├── BitcoinAdapter  ← NodeSelector → Bitcoin Core node pool
    │   └── TronAdapter     ← NodeSelector → TRON FullNode pool
    └── PostgreSQL (via pg connection pool)

Background Workers (setInterval, SKIP LOCKED for parallelism)
    ├── DepositEventProcessorWorker  — reads chain_events → deposits
    ├── TxStatusWorker               — BTC confirmation updates
    ├── SweepWorker                  — BTC sweep creation
    ├── SweepConfirmationWorker      — BTC sweep confirmation
    ├── TronSweepQueueFeeder         — fills tron_sweep_queue from tron_account_balances (10 s)
    ├── TronSweepWorker              — drains tron_sweep_queue, creates TRON sweep tasks (30 s)
    ├── TronEnergyReclaimWorker      — reclaims Stake 2.0 energy delegations (6 h)
    ├── TronBalanceRefreshWorker     — TRON balance cache safety net (5 min)
    ├── WithdrawalBatcherWorker      — builds BTC + TRON withdrawal batches
    ├── SigningTaskExpiryWorker      — expires stale signing tasks
    ├── WebhookDeliveryWorker        — HMAC-signed webhook delivery with retry
    └── NodeHealthCheckerWorker      — chain node health monitoring (30 s)

External processes
    ├── btc-indexer  (packages/btc-indexer)  → chain_events
    └── tron-indexer (packages/tron-indexer) → chain_events + tron_account_balances

External Signers
    ├── Signer OSS      (signer-oss/)  — local keys, dev/self-hosted
    └── Signer Enterprise (signer/)    — Vault Transit / AWS KMS / Azure Key Vault
```

---

## Scale

### Designed for millions of customers and transactions

The engine is built to handle the volumes of large-scale financial platforms without structural changes:

- **PostgreSQL 16+** — no ceiling on data volume; tens of millions of customers and transactions without schema changes
- **`SELECT FOR UPDATE SKIP LOCKED`** — multiple engine instances process work in parallel without coordination services or distributed locks
- **Block indexers scale independently** — deposit detection runs at O(transactions per block), not O(monitored addresses). Adding more customers does not slow down indexing.
- **Multi-node chain pools** — Bitcoin Core and TRON FullNode pools with TTL-cached dynamic failover. Node failures are transparent to the API layer.
- **Batch withdrawal processing** — withdrawals grouped and signed in bulk; throughput bounded by config, not by customer count
- **TRON balance caching** — balances written by tron-indexer after on-chain events; engine reads from a single SQL query regardless of wallet size
- **Active-active engine** — multiple engine instances can run simultaneously against the same PostgreSQL backend (cluster mode), enabling horizontal scaling and zero-downtime deployments

### Enterprise-grade isolation

- Full row-level tenant isolation: every SQL query to a tenant-scoped table is gated by `WHERE tenant_id = ?`
- Each tenant has independent: wallets, customers, ledger accounts, UTXOs, deposits, signing keys, webhook endpoints, and chain node bindings
- API keys stored as SHA-256 hashes — raw keys never stored
- Signing tasks rate-limited per signer key, with exponential backoff on the signer side

---

## Security Notes

- API keys stored as SHA-256 hashes. Raw keys are never stored.
- Webhook secrets returned only at creation — store them securely.
- No private keys are ever accepted or stored by the engine.
- Chain node credentials in `chain_nodes` use `rpc_password_ref = 'env:VAR_NAME'` — never stored as plaintext.
- Bitcoin Core and TRON FullNode RPC should only be accessible internally (never exposed publicly).
- All `.env` secrets should be excluded from version control.
- TRON SR key (`localwitness`) is a node configuration concern — the engine never sees or stores it.
- PostgreSQL file permissions and network access should be restricted to the engine process.

---

## Troubleshooting

**"Bitcoin Core RPC unavailable"**
- Check Bitcoin Core is running: `bitcoin-cli getblockchaininfo`
- Verify `BITCOIN_RPC_URL`, `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASSWORD` in `.env`
- Ensure `server=1` is in `bitcoin.conf`
- Check registered chain nodes via `GET /admin/v1/chain-nodes`

**"TRON_NO_NODES" error (503)**
- Register a TRON node: `POST /admin/v1/chain-nodes` with `chainId: "tron"`
- Or set `TRON_NODE_URL` in `.env` as fallback
- Verify the TRON FullNode is reachable at the configured URL

**Deposits not detected**
- Ensure btc-indexer or tron-indexer is running and connected to the same database
- Check `watched_addresses` table contains the deposit address
- Verify the indexer has scanned past the block containing the transaction
- Check `WORKERS_ENABLED=true` in `.env`

**TRON balances showing stale or zero**
- Check tron-indexer is running — it writes to `tron_account_balances` after each block
- Use `POST /v1/chains/tron/addresses/:address/balance-refresh` for immediate refresh (fire-and-forget, 202)
- Check `stale` and `cache_updated_at` fields in the balance response

**Rate limiting on signer daemon**
- Each signer daemon must have its own dedicated API key — shared keys share the rate limit bucket
- The signer protocol uses `SIGNER_RATE_LIMIT_PER_MIN` (default 600/min) — adjust if needed
- The signer's `PollingLoop` implements exponential backoff on 429 — verify it is not pinned to min interval

---

## Development

```bash
# Run all tests
npm test

# Run a specific test file
npx jest tests/integration/customers.test.ts

# Build TypeScript
npm run build

# Run migrations only
npm run db:migrate

# Regenerate seed data
npm run db:seed
```

Integration tests use SQLite in-memory (`:memory:`) via `bootstrapApp()`. They do not touch PostgreSQL and do not require a running chain node — RPC calls are stubbed at the service layer.
