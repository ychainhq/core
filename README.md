# Chain API (Beta)

A production-grade REST API for building Bitcoin payment processing, crypto banking, and checkout functionality. The beta version supports Bitcoin (mainnet, testnet, regtest) via Bitcoin Core JSON-RPC.

**Key capabilities:** multi-tenant architecture, address monitoring, deposit detection, payment requests with BIP-21 QR payloads, PSBT/raw transaction preparation, fee estimation, UTXO management, HMAC-signed webhooks, minimal ledger.

## How it works: FWallet, LWallet, Tenant, Customer

Two types of wallets exist in the system:

- **FWallet** (Physical Wallet) — a watch-only wallet in the Bitcoin Core node, named `btc_{tenantId}`. One per tenant, BTC only. Not exposed via API — pure monitoring infrastructure.
- **LWallet** (Logical Wallet) — a wallet record in the chain-api database representing a business role. All `/v1/wallets` endpoints operate on LWallets.

```
Bitcoin Core node (BTC only)
  └── FWallet: btc_{tenantId}         ← one per tenant, watch-only, auto-provisioned
        └── Imported addresses         ← all deposit addresses belonging to this tenant

chain-api platform
  └── Tenant (API key owner)
        ├── LWallet: tenant_hot        ← operational hot wallet (tenant-provided address)
        ├── LWallet: tenant_cold       ← cold storage (tenant-provided address)
        └── Customer (ledger identity — NOT an FWallet, NOT a Bitcoin Core construct)
              ├── LWallet: customer_deposits  ← namespace for deposit addresses
              ├── LedgerAccount (available / pending / hold per asset)
              └── TransactionHistory
```

**Key rules:**

- Each **Tenant** gets one **FWallet** in Bitcoin Core (`btc_{tenantId}`) and three **LWallets** in the chain-api DB (`customer_deposits`, `tenant_hot`, `tenant_cold`). All are provisioned automatically when the tenant is created.
- **Ethereum has no FWallet.** ETH addresses are monitored directly via node RPC — no `createwallet` or `importaddress` needed.
- Each **Customer** is a ledger construct only — no node wallet. Deposit addresses belong to the tenant's `customer_deposits` LWallet and are imported into the FWallet (BTC) for monitoring.
- The **ledger is the source of truth** for balances; Bitcoin Core is chain infrastructure.
- UTXOs are never shared between tenants: the FWallet namespace enforces node-level isolation, and `WHERE tenant_id = ?` enforces SQL-level isolation.

## Prerequisites

- **Node.js 20+**
- **Bitcoin Core** (fully synced) with JSON-RPC enabled

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set BITCOIN_RPC_URL, BITCOIN_RPC_USER, BITCOIN_RPC_PASSWORD

# 3. Run database migrations
npm run db:migrate

# 4. Seed initial data (bitcoin chain + BTC asset + API key)
npm run db:seed
# The seed will print your API key if API_KEY is not set in .env

# 5. Start the server (development)
npm run dev

# 6. Or build and start in production
npm run build && npm start
```

## Bitcoin Core Setup

Add to your `bitcoin.conf`:

```ini
server=1
rpcuser=bitcoin
rpcpassword=changeme
rpcbind=127.0.0.1
rpcallowip=127.0.0.1

# For testnet:
# testnet=1
```

**FWallet and LWallets are provisioned automatically.** When a new tenant is created via the admin API, the engine:

1. Creates the **FWallet** in Bitcoin Core: `bitcoin-cli createwallet "btc_{tenantId}" true` (watch-only)
2. Creates **LWallets** in the chain-api database: `customer_deposits`, and optionally `tenant_hot` / `tenant_cold` when addresses are provided.

You do not need to create wallets manually. The seed script (`npm run db:seed`) provisions the default tenant. Subsequent tenants are provisioned via `POST /admin/v1/tenants`.

## API Authentication

All `/v1/...` endpoints require:
```
Authorization: Bearer <your-api-key>
```

The `/health` endpoint is public.

## Endpoints Reference

### Admin: Tenant Management

All admin endpoints require `X-Admin-Key: <admin-key>`.

```bash
# Create tenant — provisions FWallet + LWallets automatically
curl -X POST /admin/v1/tenants \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Fintech",
    "assets": [
      {
        "chain": "bitcoin",
        "hotAddress": "bc1q...",   // optional — creates tenant_hot LWallet + imports into FWallet
        "coldAddress": "bc1q..."   // optional — creates tenant_cold LWallet + imports into FWallet
      }
    ]
  }'
# → always creates: FWallet btc_{tenantId} (Bitcoin Core) + LWallet customer_deposits (DB)
# → if hotAddress: LWallet tenant_hot + address registered and imported into FWallet
# → if coldAddress: LWallet tenant_cold + address registered and imported into FWallet

GET  /admin/v1/tenants
GET  /admin/v1/tenants/:tenantId
PATCH /admin/v1/tenants/:tenantId          # update name, status, metadata
GET  /admin/v1/tenants/:tenantId/config
PATCH /admin/v1/tenants/:tenantId/config   # btcConfirmationsRequired, custodyMode, limits...

# Generate API key for tenant
curl -X POST /admin/v1/tenants/:tenantId/api-keys \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"name": "primary-key"}'
# → returns apiKey (cak_...) — store securely, shown only once
```

**`assets` field structure** (designed to be extended per chain):
```json
{
  "assets": [
    {
      "chain": "bitcoin",       // required — chain identifier
      "hotAddress": "bc1q...", // optional — tenant operational hot wallet
      "coldAddress": "bc1q..."  // optional — tenant cold storage address
    }
    // future: { "chain": "ethereum", "hotAddress": "0x..." }
  ]
}
```

### Health
```bash
GET /health
```

### MCP Endpoints

The same engine is also exposed as MCP over Streamable HTTP. MCP uses the same auth and tenant isolation rules as REST.

```bash
POST /mcp/tenant
Authorization: Bearer <tenant-api-key>

POST /mcp/customer
Authorization: Bearer <customer-session-jwt>

POST /mcp/admin
X-Admin-Key: <admin-key>
```

Admin MCP is disabled by default. Enable it with:

```bash
MCP_ADMIN_ENABLED=true
```

For browser-like clients, set allowed origins:

```bash
MCP_ALLOWED_ORIGINS=http://127.0.0.1,http://localhost,https://your-admin-ui.example
```

### Chains & Assets
```bash
GET /v1/chains
GET /v1/chains/bitcoin
GET /v1/assets?chain=bitcoin
GET /v1/chains/bitcoin/assets/BTC
```

### Wallets
```bash
# Create wallet
curl -X POST /v1/wallets \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Wallet", "type": "watch_only"}'

GET /v1/wallets
GET /v1/wallets/:walletId
```

### Address Management
```bash
# Validate address
curl -X POST /v1/chains/bitcoin/addresses/validate \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"address": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"}'

# Register address to wallet
curl -X POST /v1/wallets/:walletId/addresses \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"chain": "bitcoin", "address": "bc1q...", "label": "Deposit #1"}'

GET /v1/wallets/:walletId/addresses

# Monitor address (without wallet)
curl -X POST /v1/monitors/addresses \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"chain": "bitcoin", "address": "bc1q...", "events": ["incoming"]}'

GET /v1/monitors/addresses
DELETE /v1/monitors/addresses/:monitorId
```

### Balances
```bash
GET /v1/chains/bitcoin/addresses/:address/balances
GET /v1/chains/bitcoin/addresses/:address/balances/BTC
GET /v1/wallets/:walletId/balances
```

### UTXOs & Fees
```bash
GET /v1/chains/bitcoin/addresses/:address/utxos?minConfirmations=1
GET /v1/wallets/:walletId/utxos
GET /v1/chains/bitcoin/fees
```

### Transaction Preparation & Broadcast
```bash
# Coin selection preview
curl -X POST /v1/chains/bitcoin/transactions/coin-selection \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "fromAddresses": ["bc1q..."],
    "outputs": [{"address": "bc1q...", "amount": "100000"}],
    "feeRate": 5,
    "changeAddress": "bc1q..."
  }'

# Prepare PSBT
curl -X POST /v1/chains/bitcoin/transactions/prepare \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "fromAddresses": ["bc1q..."],
    "outputs": [{"address": "bc1q...", "amount": "100000"}],
    "changeAddress": "bc1q...",
    "format": "psbt"
  }'

# Finalize PSBT (after external signing)
curl -X POST /v1/chains/bitcoin/transactions/finalize \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"psbt": "<base64-psbt>"}'

# Broadcast (idempotent)
curl -X POST /v1/chains/bitcoin/transactions/broadcast \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"rawTransaction": "<hex>"}'

# Validate without broadcasting
POST /v1/chains/bitcoin/transactions/validate

# Transaction status
GET /v1/chains/bitcoin/transactions/:txHash
GET /v1/chains/bitcoin/transactions/:txHash/status
```

### Payment Requests
```bash
# Create payment request (idempotent)
curl -X POST /v1/payment-requests \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: order-123" \
  -d '{
    "chain": "bitcoin",
    "asset": "BTC",
    "amount": "0.001",
    "walletId": "wallet_abc",
    "reference": "order-123",
    "expiresAt": "2024-12-31T23:59:59Z"
  }'

GET /v1/payment-requests?status=pending&chain=bitcoin
GET /v1/payment-requests/:paymentRequestId
POST /v1/payment-requests/:paymentRequestId/cancel
GET /v1/payment-requests/by-reference/order-123
GET /v1/payment-requests/:paymentRequestId/qr
```

### Deposits
```bash
GET /v1/deposits?walletId=wallet_abc&status=confirmed
GET /v1/deposits/:depositId
GET /v1/chains/bitcoin/addresses/:address/deposits
```

The deposit worker scans each tenant Bitcoin Core FWallet once per cycle and
maps returned UTXOs back to registered addresses in SQLite. This keeps the
worker cost proportional to tenant wallets and new UTXOs, not to the total
number of active deposit addresses.

### Customer Withdrawals
```bash
# Customer-scoped withdrawal request
POST /v1/me/withdrawals
{
  "toAddress": "bc1q...",
  "amountSats": "100000",
  "idempotencyKey": "optional-client-key"
}

GET /v1/me/withdrawals
GET /v1/me/withdrawals/:withdrawalId

# Tenant-facing operations
GET /v1/withdrawals
GET /v1/withdrawals/:withdrawalId
```

`POST /v1/me/withdrawals` validates and reserves customer balance, then creates
a `queued` withdrawal. The request path does not build a PSBT. The withdrawal
batcher consumes queued withdrawals, builds a BTC PSBT batch, creates a signing
task, and finalizes/broadcasts after the external signer submits a signature.

### Withdrawal Batches
```bash
GET /v1/withdrawal-batches
GET /v1/withdrawal-batches/:batchId
POST /v1/withdrawal-batches/:batchId/approve
POST /v1/withdrawal-batches/:batchId/reject
POST /v1/withdrawal-batches/:batchId/cancel
POST /v1/withdrawal-batches/:batchId/retry

GET /v1/tenant/withdrawal-batch-config
PATCH /v1/tenant/withdrawal-batch-config
```

The batcher can create multiple batches per worker run, bounded by
`BATCH_WORKER_MAX_BATCHES_PER_RUN`, `BATCH_WORKER_MAX_BATCHES_PER_TENANT_PER_RUN`,
and `BATCH_WORKER_MAX_RUN_MS`. BTC fee estimates are cached briefly with
`BTC_FEE_RATE_CACHE_TTL_MS`.

### Ledger
```bash
# Create ledger account
curl -X POST /v1/ledger/accounts \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"walletId": "wallet_abc", "chainId": "bitcoin", "assetId": "bitcoin:BTC", "name": "Main Account"}'

GET /v1/ledger/accounts
GET /v1/ledger/accounts/:ledgerAccountId
GET /v1/ledger/accounts/:ledgerAccountId/balances
GET /v1/ledger/accounts/:ledgerAccountId/entries

# Internal transfer (idempotent)
curl -X POST /v1/ledger/transfers \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: transfer-456" \
  -d '{
    "fromLedgerAccountId": "lacc_abc",
    "toLedgerAccountId": "lacc_def",
    "assetId": "bitcoin:BTC",
    "amount": "50000"
  }'
```

### Webhooks
```bash
# Create webhook (secret returned only once!)
curl -X POST /v1/webhooks \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "url": "https://your-server.com/webhooks",
    "events": ["deposit.detected", "deposit.confirmed", "payment_request.paid"],
    "chains": ["bitcoin"]
  }'

GET /v1/webhooks
PATCH /v1/webhooks/:webhookId
DELETE /v1/webhooks/:webhookId
POST /v1/webhooks/:webhookId/test

GET /v1/webhook-deliveries?webhookId=wh_abc&status=failed
POST /v1/webhook-deliveries/:deliveryId/retry
```

## Webhook Signature Verification

Each webhook delivery includes these headers:
- `X-CryptoApi-Event-Id`: `evt_<uuid>`
- `X-CryptoApi-Timestamp`: Unix timestamp in milliseconds
- `X-CryptoApi-Signature`: HMAC-SHA256 hex signature

Verification example (Node.js):
```javascript
const crypto = require('crypto');

function verifyWebhook(secret, timestamp, body, signature) {
  const message = `${timestamp}.${JSON.stringify(body)}`;
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

## Idempotency

POST endpoints that create resources support the `Idempotency-Key` header:
```
Idempotency-Key: <unique-key>
```

Results are cached for 24 hours. Sending the same key returns the original response without executing the operation again.

Supported operations: payment requests, broadcasts, ledger transfers.

## Architecture

```
Express API (src/app.ts)
    ├── Auth middleware (API key SHA-256 hash lookup)
    ├── Rate limit middleware (in-memory sliding window, 100 req/min)
    └── Routes /v1/*
            │
    ┌───────┼────────────────┐
    │       │                │
Services   Chain Adapters   SQLite (WAL mode)
    │       │                │
    │   BitcoinAdapter       better-sqlite3
    │   └── BitcoinRpcClient (JSON-RPC to Bitcoin Core)
    │
Background Workers (setInterval)
    ├── DepositMonitorWorker  (30s)
    ├── TxStatusWorker        (60s)
    ├── SweepWorker
    ├── SweepConfirmationWorker
    ├── WithdrawalBatcherWorker
    ├── SigningTaskExpiryWorker
    └── WebhookDeliveryWorker (10s)
```

## Security Notes

- API keys stored as SHA-256 hashes. The raw key is never stored.
- Webhook secrets returned only at creation — store them securely.
- No private keys are ever accepted or stored by this API.
- SQLite file should have `600` permissions: `chmod 600 data/crypto-api.sqlite`
- Bitcoin Core RPC should only be accessible internally (never exposed publicly).
- All `.env` secrets should be excluded from version control.

## Troubleshooting

**"Bitcoin Core RPC unavailable"**
- Check Bitcoin Core is running: `bitcoin-cli getblockchaininfo`
- Verify `BITCOIN_RPC_URL`, `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASSWORD` in `.env`
- Ensure `server=1` is in `bitcoin.conf`

**"UTXOs not found for address"**
- Ensure the address was registered via `POST /v1/monitors/addresses` — this imports it into the tenant's Bitcoin Core wallet
- Verify the tenant's wallet (`btc_{tenantId}`) is loaded: `bitcoin-cli listwallets`

**Deposits not detected**
- Ensure addresses are in `watched_addresses` (via `POST /v1/monitors/addresses` or wallet address registration)
- Check `WORKERS_ENABLED=true` in `.env`
- Verify Bitcoin Core is fully synced

**Rate limiting**
- Default: 100 requests/minute per API key
- Adjust via `RATE_LIMIT_PER_MIN` in `.env`

## Development

```bash
# Run tests
npm test

# Build TypeScript
npm run build

# Run migrations only
npm run db:migrate
```
