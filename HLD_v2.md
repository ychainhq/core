# Chain API — High-Level Design v2 (Multi-tenant Beta)

> Dokument v2 rozszerza v1 (`HLD.md`) o multi-tenancy. Wszystkie decyzje z v1 są zachowane — zmiany dotyczą wyłącznie warstwy izolacji danych, modelu hierarchii i nowych endpointów.

---

## 0. Co nowego w v2

### 0.1 Kluczowa zmiana: multi-tenancy

v1 to implementacja single-tenant — jeden zestaw API keys, jedna przestrzeń zasobów. v2 wprowadza pełną izolację między tenantami: każda firma korzystająca z platformy dostaje własny, szczelnie odizolowany kontekst danych.

**Hierarchia:**

```
Platform (operator chain-api)
  └── Tenant (biznesowy klient, np. sklep, fintech)
        ├── Tenant config (confirmation policy, limity, webhook_url)
        ├── Tenant wallets (hot = do wypłat, cold = treasury)
        └── Customers (końcowi użytkownicy tenanta)
              ├── Ledger accounts (BTC)
              ├── Deposit addresses
              └── Deposit history
```

API key jest per-tenant. Każde żądanie jest automatycznie scoped do tenanta na podstawie `tenant_id` wyciągniętego z api_key lookup.

### 0.2 Custody mode w MVP

MVP v2 obsługuje wyłącznie:

- `watch_only` — adres zewnętrzny, monitorowany, nie nasz
- `external_signer` — nasz adres (pochodny z xpub lub zarejestrowany), klucz po stronie klienta

Platforma przygotowuje PSBT, klient podpisuje, broadcast przez API. Identycznie jak w v1.

`platform_custody` i `hybrid_custody` (HSM/KMS/MPC) są zaplanowane na przyszłość — poza zakresem v2 bety.

### 0.3 Nowe komponenty

- Tabele: `tenants`, `tenant_configs`, `customers`, `admin_keys`
- Admin API: `/admin/v1/*` (auth przez `X-Admin-Key`)
- Customer API: `/v1/customers/*` (tenant-scoped)
- Tenant Context Middleware (api_key → tenant_id → tenant config)
- Nowe event types: `customer.created`, `customer.disabled`, `tenant.config_changed`, `tenant.api_key_created`

---

## 1. Cel wersji beta

### Co beta robi (zachowane z v1 + rozszerzenia v2)

- Obsługuje Bitcoin mainnet jako jedyny chain.
- Monitoruje adresy BTC podane przez klienta (watch-only mode, Tryb B).
- Wykrywa depozyty w mempolu i po potwierdzeniach.
- Generuje payment requesty z adresem BTC i QR payload zgodnym z BIP-21.
- Zwraca UTXO dla adresów.
- Szacuje fee (sat/vbyte) przez Bitcoin Core `estimatesmartfee`.
- Przygotowuje unsigned transakcje / PSBT do podpisu przez klienta.
- Broadcastuje gotowe podpisane raw transakcje.
- Monitoruje status transakcji w mempolu i po potwierdzeniach.
- Dostarcza webhooki HMAC-podpisane dla kluczowych zdarzeń.
- Prowadzi minimalny ledger (pending/settled balances) powiązany z depozytami.
- Wymaga autoryzacji API key (`Authorization: Bearer`).
- Obsługuje `Idempotency-Key` dla operacji POST.
- Działa na jednym serwerze jako jeden proces Node.js + SQLite.
- **[v2]** Obsługuje wielu tenantów z pełną izolacją danych.
- **[v2]** Umożliwia przypisanie zasobów (adresy, depozyty, ledger) do customerów tenanta.
- **[v2]** Udostępnia Admin API dla operatora platformy.

### Czego beta świadomie nie robi (bez zmian)

- Brak Ethereum, EVM, L2, ERC-20.
- Brak custody: API nie trzyma kluczy prywatnych klientów.
- Brak podpisywania transakcji po stronie API.
- Brak generowania adresów z xpub (Tryb A — zaplanowany jako kolejny krok).
- Brak withdrawals managed z approval flow (klient sam podpisuje PSBT).
- Brak multisig production flow.
- Brak AML/risk scoring.
- Brak enterprise accounting.
- Brak Postgres / Redis / BullMQ.
- Brak checkout session.
- Brak platform_custody / hybrid_custody (HSM/KMS/MPC).

---

## 2. Zakres funkcjonalny beta

| Obszar | v1 | v2 |
|--------|----|----|
| Chains/assets metadata | ✅ | ✅ |
| Wallets (z wallet_role) | ✅ | ✅ |
| Address validation | ✅ | ✅ |
| Address monitoring (watch mode) | ✅ | ✅ |
| Balances via Bitcoin Core | ✅ | ✅ |
| UTXO query | ✅ | ✅ |
| Payment requests | ✅ | ✅ |
| Deposit detection & confirmation | ✅ | ✅ |
| Transaction preparation (PSBT/raw) | ✅ | ✅ |
| Raw tx broadcast | ✅ | ✅ |
| Transaction status monitoring | ✅ | ✅ |
| Fee estimation | ✅ | ✅ |
| Minimal ledger (pending/settled) | ✅ | ✅ |
| Webhooks (HMAC signed) | ✅ | ✅ |
| API key auth | ✅ | ✅ |
| Idempotency keys | ✅ | ✅ |
| In-process background workers | ✅ | ✅ |
| SQLite persistence | ✅ | ✅ |
| **Multi-tenancy** | ❌ | ✅ |
| **Admin API (operator platformy)** | ❌ | ✅ |
| **Customer management** | ❌ | ✅ |
| **Customer balances/deposits/addresses** | ❌ | ✅ |
| **Tenant config (per-tenant policy)** | ❌ | ✅ |

---

## 3. Zakres poza betą (bez zmian)

- **Ethereum mainnet** — account-based chain, EIP-1559 fee model
- **EVM L2** — Base, Arbitrum One, Optimism, Polygon PoS
- **ERC-20 tokens** — USDC, USDT, DAI, WBTC
- **Custodial signing** — przechowywanie kluczy po stronie API, HSM
- **platform_custody / hybrid_custody** — MPC, zdalny signer, key management
- **Multisig production flow** — BTC P2WSH multisig, EVM smart-contract wallet
- **Application-level approvals** — workflow zatwierdzania, policies
- **Managed withdrawals** — zlecenia wypłat z approval flow
- **AML / risk scoring** — Chainalysis, Elliptic i inne
- **Advanced forensic** — śledzenie przepływu środków, clustering
- **Enterprise accounting** — reconciliation, raportowanie, eksport ERP
- **Postgres / high availability** — migracja z SQLite
- **Redis / distributed queues** — zewnętrzna kolejka
- **BullMQ** — zaawansowane zarządzanie kolejkami
- **Checkout sessions** — multi-asset checkout z konwersją fiat-krypto
- **Address generation z xpub** (Tryb A) — HD deterministic addresses

---

## 4. Architektura komponentów

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Express REST API                             │
│  /admin/v1/*  (admin auth)         /v1/*  (tenant auth)             │
└──────────────────┬───────────────────────────────────────────────────┘
                   │
     ┌─────────────▼────────────────────────────────┐
     │          Tenant Context Middleware             │
     │  Bearer token → key_hash → api_keys           │
     │  → tenant_id → tenants (status check)         │
     │  → tenant_config → request context            │
     └─────────────┬────────────────────────────────┘
                   │
     ┌─────────────▼──────────────────────────────────────────┐
     │                  Business Services                      │
     │  CustomerService    PaymentReqService  DepositService   │
     │  TransactionService WebhookService     LedgerService    │
     └─────────────┬──────────────────────────────────────────┘
                   │
     ┌─────────────▼──────────────────────────────────────────┐
     │            Chain Adapter Layer (IChainAdapter)          │
     │  BitcoinAdapter (JSON-RPC)    EthereumAdapter (stub)   │
     └─────────────┬──────────────────────────────────────────┘
                   │
     ┌─────────────▼──────────────────────────────────────────┐
     │          SQLite Persistence (tenant-scoped queries)     │
     │  better-sqlite3 / WAL mode / Foreign keys              │
     │  Wszystkie queries: WHERE tenant_id = ?                │
     └─────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────┐
     │          In-process Background Workers                   │
     │  DepositMonitorWorker    (per-tenant wallet scan)       │
     │  WebhookDeliveryWorker   (delivery + auto-pause)        │
     │  TxStatusWorker          (per-tenant monitoring)        │
     │  WithdrawalBatcherWorker (multi-batch, round-robin)     │
     │  SweepWorker / SweepConfirmationWorker                  │
     │  SigningTaskExpiryWorker                                 │
     │  WalCheckpointWorker     (SQLite WAL maintenance)       │
     │  RetentionWorker         (webhook_deliveries cleanup)   │
     └──────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────┐
     │  Bitcoin Core Node  (shared infrastructure, bez kluczy) │
     └──────────────────────────────────────────────────────────┘
```

### Opis komponentów

**Express REST API** — serwer HTTP obsługujący `/admin/v1/*` (admin) i `/v1/*` (tenant). Routing, walidacja wejścia, autoryzacja, idempotencja, formatowanie odpowiedzi.

**Tenant Context Middleware** — wyciąga Bearer token, hashuje, szuka w `api_keys`, ładuje `tenant_id`, weryfikuje status tenanta (`active`), dołącza do kontekstu żądania. Wszystkie następne warstwy korzystają z `req.tenantId`.

**Admin Middleware** — wyciąga `X-Admin-Key`, hashuje, szuka w `admin_keys`. Brak tenant_id — może operować na wszystkich tenantach. Dostępne wyłącznie dla `/admin/v1/*`.

**CustomerService** — zarządza lifecycle customerów tenanta (CRUD, disable, freeze).

**SQLite persistence layer** — SQLite z WAL mode. Jedyne wymaganie trwałego storage. Każde zapytanie zawiera `WHERE tenant_id = ?`.

**Chain adapter layer** — interfejs `IChainAdapter`. `BitcoinAdapter` komunikuje się z Bitcoin Core przez JSON-RPC. `EthereumAdapter` — placeholder.

**Payment request service** — lifecycle payment requestów (created → pending → detected → paid/expired). Przypisuje `tenant_id`, opcjonalnie `customer_id`.

**Deposit monitor/indexer** — polling worker wykrywający nowe bloki i transakcje na monitorowanych adresach, filtrowany per-tenant.

**Transaction preparation service** — przygotowuje PSBT / unsigned raw tx. Coin selection z guardem `tenant_id`. Nie trzyma kluczy.

**Broadcast service** — przyjmuje podpisaną raw tx, waliduje przez `testmempoolaccept`, broadcastuje.

**Webhook service** — per-tenant subskrypcje i dostarczanie zdarzeń. HMAC-signed payloads.

**Minimal ledger service** — śledzi saldo pending/settled per tenant i per customer.

**In-process background workers** — trzy workery jako `setInterval` w tym samym procesie Node.js.

**Migration runner** — sekwencyjne migracje SQLite przez `db:migrate`.

**Configuration loader** — wczytuje `.env` przez `dotenv`, waliduje wymagane zmienne.

---

## 5. Model danych

### 5.0 Nowe tabele (v2)

#### Tabela: `tenants`

```sql
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,          -- 'tenant_...'
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended' | 'disabled'
  metadata      TEXT,                      -- JSON
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

#### Tabela: `tenant_configs`

```sql
CREATE TABLE tenant_configs (
  tenant_id                  TEXT PRIMARY KEY REFERENCES tenants(id),
  btc_confirmations_required INTEGER NOT NULL DEFAULT 1,
  btc_finality_confirmations INTEGER NOT NULL DEFAULT 6,
  custody_mode               TEXT NOT NULL DEFAULT 'external_signer',  -- 'external_signer' only in MVP
  withdrawal_mode            TEXT NOT NULL DEFAULT 'external_signer',
  daily_withdrawal_limit_sats TEXT,        -- NULL = unlimited
  per_tx_limit_sats          TEXT,         -- NULL = unlimited
  webhook_secret             TEXT,
  updated_at                 TEXT NOT NULL
);
```

#### Tabela: `customers`

```sql
CREATE TABLE customers (
  id                TEXT PRIMARY KEY,   -- 'cust_...'
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  reference         TEXT,              -- zewnętrzny ID tenanta (CRM / onboarding)
  party_type        TEXT NOT NULL DEFAULT 'natural_person', -- 'natural_person' | 'legal_entity'
  status            TEXT NOT NULL DEFAULT 'active',
    -- 'pending' | 'active' | 'restricted' | 'suspended' | 'frozen'
    -- | 'closed' | 'rejected' | 'disabled' (legacy)
  display_name      TEXT,              -- zsynchronizowany z profilu; używany w logach i wyszukiwaniu
  country_of_origin TEXT,             -- ISO 3166-1 alpha-2
  metadata          TEXT,             -- JSON (stopniowo zastępowany przez sub-zasoby KYC)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
-- Sub-zasoby KYC (migration 009):
--   customer_profiles         — NaturalPersonProfile | LegalEntityProfile (1:1)
--   customer_identifiers      — PASSPORT, TAX_ID, LEI, itp. (N:1)
--   customer_relationships    — UBO, trustee, representative, itp. (N:1)
--   customer_aml_kyc          — profil AML/KYC (1:1, auto-provision przy tworzeniu)
--   customer_data_governance  — GDPR/DORA/NIS2 (1:1, auto-provision przy tworzeniu)
--   customer_contact          — email, telefon, adresy (1:1)
--   customer_documents        — referencje do dokumentów, bez przechowywania pliku (N:1)
```

#### Tabela: `admin_keys`

```sql
CREATE TABLE admin_keys (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,        -- SHA-256 hash
  name        TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
```

### 5.1 Tabele globalne (bez zmian)

`chains` i `assets` pozostają globalne — shared między wszystkimi tenantami.

#### Tabela: `chains`

```sql
CREATE TABLE chains (
  id            TEXT PRIMARY KEY,          -- 'bitcoin', 'ethereum'
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,             -- 'utxo' | 'account'
  native_asset  TEXT NOT NULL,             -- 'BTC', 'ETH'
  chain_id      INTEGER,                   -- NULL dla BTC, 1 dla ETH mainnet
  finality_type TEXT NOT NULL,             -- 'confirmations' | 'safe_finalized'
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  metadata      TEXT,                      -- JSON
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

#### Tabela: `assets`

```sql
CREATE TABLE assets (
  id               TEXT PRIMARY KEY,       -- 'bitcoin:BTC', 'ethereum:USDC'
  chain_id         TEXT NOT NULL REFERENCES chains(id),
  symbol           TEXT NOT NULL,          -- 'BTC', 'USDC'
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,          -- 'native' | 'token'
  contract_address TEXT,                   -- NULL dla native, '0x...' dla ERC-20
  decimals         INTEGER NOT NULL,       -- 8 dla BTC, 6 dla USDC, 18 dla ETH
  is_enabled       INTEGER NOT NULL DEFAULT 1,
  metadata         TEXT,                   -- JSON
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
```

### 5.2 Tabele tenant-scoped (zaktualizowane z v1)

#### Tabela: `wallets`

```sql
CREATE TABLE wallets (
  id          TEXT PRIMARY KEY,            -- 'wallet_...'
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,               -- 'watch_only' | 'external_signer'
  wallet_role TEXT NOT NULL DEFAULT 'watch_only',
    -- 'tenant_hot'         — hot wallet tenanta (do wypłat)
    -- 'tenant_cold'        — cold wallet (treasury)
    -- 'customer_deposits'  — namespace dla adresów depozytowych customerów
    -- 'watch_only'         — jak w v1 (adresy zewnętrzne)
  status      TEXT NOT NULL DEFAULT 'active',
  metadata    TEXT,                        -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

#### Tabela: `addresses`

```sql
CREATE TABLE addresses (
  id           TEXT PRIMARY KEY,           -- 'addr_...'
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  customer_id  TEXT REFERENCES customers(id),   -- NULL jeśli nie customer-specific
  wallet_id    TEXT NOT NULL REFERENCES wallets(id),
  chain_id     TEXT NOT NULL REFERENCES chains(id),
  address      TEXT NOT NULL,
  label        TEXT,
  address_type TEXT,                       -- 'p2wpkh' | 'p2sh' | 'p2pkh' | 'p2tr'
  address_role TEXT NOT NULL DEFAULT 'customer_deposit',
    -- 'customer_deposit' | 'tenant_hot' | 'tenant_cold' | 'change' | 'watch_only'
  status       TEXT NOT NULL DEFAULT 'active',
  metadata     TEXT,                       -- JSON
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(chain_id, address)
);
```

#### Tabela: `watched_addresses`

```sql
CREATE TABLE watched_addresses (
  id          TEXT PRIMARY KEY,            -- 'mon_...'
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT REFERENCES customers(id),
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  address     TEXT NOT NULL,
  wallet_id   TEXT REFERENCES wallets(id),
  label       TEXT,
  events      TEXT NOT NULL DEFAULT '["incoming"]',  -- JSON array
  webhook_id  TEXT REFERENCES webhooks(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT,                        -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(chain_id, address)
);
```

#### Tabela: `payment_requests`

```sql
CREATE TABLE payment_requests (
  id                     TEXT PRIMARY KEY,  -- 'payreq_...'
  tenant_id              TEXT NOT NULL REFERENCES tenants(id),
  customer_id            TEXT REFERENCES customers(id),
  chain_id               TEXT NOT NULL REFERENCES chains(id),
  asset_id               TEXT NOT NULL REFERENCES assets(id),
  wallet_id              TEXT REFERENCES wallets(id),
  address                TEXT NOT NULL,
  amount_raw             TEXT NOT NULL,     -- satoshi jako string
  amount_display         TEXT NOT NULL,     -- '0.001' BTC
  reference              TEXT,
  status                 TEXT NOT NULL DEFAULT 'created',
  expires_at             TEXT,              -- ISO8601
  confirmations_required INTEGER NOT NULL DEFAULT 1,
  qr_payload             TEXT,             -- BIP-21 URI
  metadata               TEXT,             -- JSON
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
```

#### Tabela: `deposits`

```sql
CREATE TABLE deposits (
  id                  TEXT PRIMARY KEY,     -- 'dep_...'
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  customer_id         TEXT REFERENCES customers(id),
  chain_id            TEXT NOT NULL REFERENCES chains(id),
  asset_id            TEXT NOT NULL REFERENCES assets(id),
  wallet_id           TEXT REFERENCES wallets(id),
  address             TEXT NOT NULL,
  amount_raw          TEXT NOT NULL,        -- satoshi jako string
  amount_display      TEXT NOT NULL,
  tx_hash             TEXT NOT NULL,
  vout                INTEGER,              -- BTC output index
  block_height        INTEGER,              -- NULL jeśli unconfirmed
  block_hash          TEXT,
  confirmations       INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'detected',
  payment_request_id  TEXT REFERENCES payment_requests(id),
  metadata            TEXT,                 -- JSON
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(chain_id, tx_hash, vout)
);
```

#### Tabela: `transactions`

```sql
CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,           -- 'tx_...'
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  chain_id      TEXT NOT NULL REFERENCES chains(id),
  tx_hash       TEXT,
  raw_tx        TEXT,                       -- hex encoded
  psbt          TEXT,                       -- base64 jeśli PSBT
  status        TEXT NOT NULL DEFAULT 'prepared',
  block_height  INTEGER,
  block_hash    TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  fee_raw       TEXT,                       -- satoshi
  fee_rate      TEXT,                       -- sat/vbyte
  wallet_id     TEXT REFERENCES wallets(id),
  broadcast_at  TEXT,
  metadata      TEXT,                       -- JSON
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

#### Tabela: `cached_utxos`

> KLUCZOWE: `tenant_id` chroni przed cross-tenant UTXO usage. Coin selection NIGDY nie może użyć UTXO z innego tenanta.

```sql
CREATE TABLE cached_utxos (
  id             TEXT PRIMARY KEY,          -- 'utxo_...'
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  customer_id    TEXT REFERENCES customers(id),
  chain_id       TEXT NOT NULL REFERENCES chains(id),
  address        TEXT NOT NULL,
  tx_hash        TEXT NOT NULL,
  vout           INTEGER NOT NULL,
  amount_raw     TEXT NOT NULL,             -- satoshi
  script_pub_key TEXT,
  confirmations  INTEGER NOT NULL DEFAULT 0,
  is_spent       INTEGER NOT NULL DEFAULT 0,
  is_locked      INTEGER NOT NULL DEFAULT 0,  -- locked podczas withdrawal construction
  wallet_id      TEXT REFERENCES wallets(id),
  wallet_role    TEXT,                      -- 'customer_deposit' | 'tenant_hot' | 'tenant_cold'
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(chain_id, tx_hash, vout)
);
```

#### Tabela: `ledger_accounts`

```sql
CREATE TABLE ledger_accounts (
  id           TEXT PRIMARY KEY,            -- 'lacc_...'
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  customer_id  TEXT REFERENCES customers(id),
  wallet_id    TEXT REFERENCES wallets(id),
  chain_id     TEXT NOT NULL REFERENCES chains(id),
  asset_id     TEXT NOT NULL REFERENCES assets(id),
  account_type TEXT NOT NULL DEFAULT 'customer_available',
    -- 'customer_available'    — dostępne saldo customera
    -- 'customer_pending'      — pending (0-conf lub poniżej progu)
    -- 'customer_hold'         — zablokowane (withdrawal w toku)
    -- 'tenant_hot_control'    — kontrola hot wallet tenanta
    -- 'tenant_cold_control'   — kontrola cold wallet
    -- 'tenant_fee_revenue'    — przychody z fee platformy
    -- 'network_fee_expense'   — wydatki na network fee
    -- 'sweep_in_transit'      — środki w sweepie między adresami
  name         TEXT NOT NULL,
  metadata     TEXT,                        -- JSON
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

#### Tabela: `ledger_entries`

```sql
CREATE TABLE ledger_entries (
  id                   TEXT PRIMARY KEY,    -- 'lent_...'
  tenant_id            TEXT NOT NULL REFERENCES tenants(id),
  ledger_account_id    TEXT NOT NULL REFERENCES ledger_accounts(id),
  type                 TEXT NOT NULL,
    -- 'deposit_pending' | 'deposit_settled' | 'withdrawal' | 'transfer_in' | 'transfer_out'
  amount_raw           TEXT NOT NULL,       -- satoshi, signed: positive = credit, negative = debit
  reference_type       TEXT,               -- 'deposit' | 'transaction' | 'transfer'
  reference_id         TEXT,
  balance_pending_raw  TEXT NOT NULL,      -- running balance pending po wpisie
  balance_settled_raw  TEXT NOT NULL,      -- running balance settled po wpisie
  metadata             TEXT,              -- JSON
  created_at           TEXT NOT NULL
);
```

#### Tabela: `webhooks`

```sql
CREATE TABLE webhooks (
  id          TEXT PRIMARY KEY,             -- 'wh_...'
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  url         TEXT NOT NULL,
  events      TEXT NOT NULL,               -- JSON array event types
  chains      TEXT,                        -- JSON array, NULL = all
  wallet_id   TEXT REFERENCES wallets(id),
  secret      TEXT NOT NULL,               -- HMAC secret
  is_active   INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT,                        -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

#### Tabela: `webhook_deliveries`

```sql
CREATE TABLE webhook_deliveries (
  id            TEXT PRIMARY KEY,           -- 'wdlv_...'
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  webhook_id    TEXT NOT NULL REFERENCES webhooks(id),
  event_id      TEXT NOT NULL,              -- 'evt_...'
  event_type    TEXT NOT NULL,
  payload       TEXT NOT NULL,             -- JSON string
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_retry_at TEXT,
  delivered_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

#### Tabela: `api_keys`

```sql
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  key_hash     TEXT NOT NULL UNIQUE,        -- SHA-256 hash klucza
  name         TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);
```

#### Tabela: `idempotency_keys`

```sql
CREATE TABLE idempotency_keys (
  tenant_id   TEXT NOT NULL,
  key         TEXT NOT NULL,
  operation   TEXT NOT NULL,               -- 'payment_request' | 'broadcast' | 'webhook' | 'ledger_transfer'
  result      TEXT NOT NULL,               -- JSON serialized response
  status_code INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key, operation)
);
```

#### Tabela: `jobs`

```sql
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT REFERENCES tenants(id),  -- NULL = platform-wide job
  type         TEXT NOT NULL,               -- 'deposit_check' | 'webhook_delivery'
  status       TEXT NOT NULL DEFAULT 'pending',
  payload      TEXT NOT NULL,              -- JSON
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at  TEXT NOT NULL,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

#### Tabela: `customer_withdrawals`

```sql
CREATE TABLE customer_withdrawals (
  id              TEXT PRIMARY KEY,           -- 'wd_...'
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  chain_id        TEXT NOT NULL DEFAULT 'bitcoin',
  asset_id        TEXT NOT NULL DEFAULT 'bitcoin:BTC',
  to_address      TEXT NOT NULL,
  amount_raw      TEXT NOT NULL,             -- sats requested by customer
  fee_raw         TEXT,                      -- fee in sats (set when PSBT built)
  psbt            TEXT,                      -- base64 PSBT sent for signing
  signed_psbt     TEXT,
  tx_hash         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending_signature',
  -- 'queued' | 'batched' | 'pending_signature' | 'broadcast' | 'confirmed' | 'failed'
  error           TEXT,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

#### Tabela: `withdrawal_batches`

```sql
CREATE TABLE withdrawal_batches (
  id                      TEXT PRIMARY KEY,  -- 'wdb_...'
  tenant_id               TEXT NOT NULL REFERENCES tenants(id),
  chain_id                TEXT NOT NULL DEFAULT 'bitcoin',
  asset_id                TEXT NOT NULL DEFAULT 'bitcoin:BTC',
  status                  TEXT NOT NULL DEFAULT 'pending_approval',
  -- 'pending_approval' | 'approved' | 'pending_signature' | 'broadcast' | 'confirmed'
  -- | 'failed' | 'rejected' | 'cancelled'
  outputs_count           INTEGER NOT NULL DEFAULT 0,
  total_output_raw        TEXT,              -- sats
  fee_raw                 TEXT,              -- fee in sats
  fee_rate_sat_vb         TEXT,
  psbt                    TEXT,
  signed_psbt             TEXT,
  tx_hash                 TEXT,
  rbf_enabled             INTEGER NOT NULL DEFAULT 1,
  decision_mode           TEXT NOT NULL DEFAULT 'manual',
  signer_id               TEXT,
  approved_by             TEXT,
  rejection_reason        TEXT,
  rejected_by             TEXT,
  attempt_count           INTEGER NOT NULL DEFAULT 0,
  replaced_by_batch_id    TEXT,
  replacement_of_batch_id TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
```

#### Tabela: `tenant_withdrawal_batch_configs`

Konfiguracja polityki batchowania i opłat dla tenanta. Jeden wiersz per tenant.

```sql
CREATE TABLE tenant_withdrawal_batch_configs (
  tenant_id                TEXT PRIMARY KEY REFERENCES tenants(id),
  btc_batching_enabled     INTEGER NOT NULL DEFAULT 1,
  btc_min_outputs_per_batch INTEGER NOT NULL DEFAULT 1,
  btc_max_outputs_per_batch INTEGER NOT NULL DEFAULT 200,
  btc_max_batch_age_seconds INTEGER NOT NULL DEFAULT 30,
  btc_max_fee_rate_sat_vb  INTEGER NOT NULL DEFAULT 50,
  btc_target_blocks        INTEGER NOT NULL DEFAULT 6,
  btc_rbf_enabled          INTEGER NOT NULL DEFAULT 1,
  btc_cpfp_enabled         INTEGER NOT NULL DEFAULT 0,
  withdrawal_fee_coverage  TEXT NOT NULL DEFAULT 'tenant_pays',
  -- 'tenant_pays'    — platform absorbs fee; recipient receives full amount
  -- 'sender_pays'    — customer billed amount + fee (debit = amount + fee)
  -- 'recipient_pays' — recipient receives amount − fee
  updated_at               TEXT NOT NULL
);
```

---

## 6. REST API v2

### 6.0 Admin API (platform operator)

Auth: `X-Admin-Key` header (lub Bearer z flagą is_admin). Dostępne wyłącznie dla `/admin/v1/*`. Brak tenant_id — może operować na wszystkich tenantach.

| Method | Path | Opis |
|--------|------|------|
| POST | `/admin/v1/tenants` | Utwórz tenanta |
| GET | `/admin/v1/tenants` | Lista tenantów |
| GET | `/admin/v1/tenants/:tenantId` | Szczegóły tenanta |
| PATCH | `/admin/v1/tenants/:tenantId` | Aktualizuj tenanta |
| GET | `/admin/v1/tenants/:tenantId/config` | Konfiguracja tenanta |
| PATCH | `/admin/v1/tenants/:tenantId/config` | Aktualizuj konfigurację tenanta |
| POST | `/admin/v1/tenants/:tenantId/api-keys` | Wygeneruj API key dla tenanta |
| POST | `/admin/v1/tenants/:tenantId/disable` | Zawieś tenanta |

### 6.1 Health (publiczne, bez zmian)

| Method | Path | Opis |
|--------|------|------|
| GET | `/health` | Sprawdzenie stanu serwera (bez auth) |

### 6.2 Customer API (tenant-scoped)

#### 6.2.1 Core Party (ledger + identity)

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/customers` | Utwórz customera (Party aggregate — reference, party_type, display_name, country_of_origin, metadata) |
| GET | `/v1/customers` | Lista customerów tenanta. Query params: `status`, `party_type`, `id`, `reference`, `display_name`, `country_of_origin` (customers table); `profile_given_name`, `profile_family_name`, `profile_middle_name`, `profile_business_name` (EXISTS na customer_profiles); `contact_email`, `contact_phone` (EXISTS na customer_contact); `identifier_type`, `identifier_value` (EXISTS na customer_identifiers); `rel_display_name`, `rel_identifier_type`, `rel_identifier_value` (EXISTS + JSON_EXTRACT na customer_relationships.external_party). Filtry łączone AND. Pola tekstowe obsługują wildcard `*` → `%` SQL LIKE; bez `*` → implicit substring `%term%`. |
| GET | `/v1/customers/:customerId` | Szczegóły customera |
| PATCH | `/v1/customers/:customerId` | Aktualizuj customera (reference, status, display_name, country_of_origin, metadata) |
| POST | `/v1/customers/:customerId/disable` | Dezaktywuj customera (status → disabled) |
| GET | `/v1/customers/:customerId/balances` | Saldo BTC (pending + settled) |
| GET | `/v1/customers/:customerId/deposits` | Historia depozytów customera |
| GET | `/v1/customers/:customerId/addresses` | Adresy depozytowe customera |

#### 6.2.2 KYC Profile sub-resources

| Method | Path | Opis |
|--------|------|------|
| PUT | `/v1/customers/:customerId/profile` | Utwórz / zastąp profil (NaturalPersonProfile lub LegalEntityProfile, discriminator: partyType) |
| GET | `/v1/customers/:customerId/profile` | Pobierz profil |
| POST | `/v1/customers/:customerId/identifiers` | Dodaj identyfikator (PASSPORT, TAX_ID, LEI, itp.) |
| GET | `/v1/customers/:customerId/identifiers` | Lista identyfikatorów |
| PATCH | `/v1/customers/:customerId/identifiers/:identifierId` | Zaktualizuj identyfikator |
| DELETE | `/v1/customers/:customerId/identifiers/:identifierId` | Usuń identyfikator |
| POST | `/v1/customers/:customerId/relationships` | Dodaj relację (UBO, reprezentant, powiernik, itp.) |
| GET | `/v1/customers/:customerId/relationships` | Lista relacji |
| PATCH | `/v1/customers/:customerId/relationships/:relationshipId` | Zaktualizuj relację |
| DELETE | `/v1/customers/:customerId/relationships/:relationshipId` | Usuń relację |
| PUT | `/v1/customers/:customerId/aml-kyc` | Utwórz / zaktualizuj profil AML/KYC |
| GET | `/v1/customers/:customerId/aml-kyc` | Pobierz profil AML/KYC |
| PUT | `/v1/customers/:customerId/data-governance` | Utwórz / zaktualizuj profil data governance (GDPR, DORA, NIS2) |
| GET | `/v1/customers/:customerId/data-governance` | Pobierz profil data governance |
| PUT | `/v1/customers/:customerId/contact` | Utwórz / zaktualizuj dane kontaktowe |
| GET | `/v1/customers/:customerId/contact` | Pobierz dane kontaktowe |
| POST | `/v1/customers/:customerId/documents` | Dodaj referencję dokumentu (bez przechowywania pliku) |
| GET | `/v1/customers/:customerId/documents` | Lista referencji dokumentów |
| PATCH | `/v1/customers/:customerId/documents/:documentId` | Zaktualizuj referencję dokumentu |
| DELETE | `/v1/customers/:customerId/documents/:documentId` | Usuń referencję dokumentu |

### 6.3 Metadata (bez zmian, tenant-scoped)

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/chains` | Lista chainów |
| GET | `/v1/chains/:chain` | Szczegóły chainu |
| GET | `/v1/assets` | Lista assetów (query: `chain`, `type`) |
| GET | `/v1/chains/:chain/assets/:asset` | Szczegóły assetu |

### 6.4 Wallets (rozszerzone o wallet_role)

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/wallets` | Utwórz wallet (nowe pole: `walletRole`) |
| GET | `/v1/wallets` | Lista walletów tenanta |
| GET | `/v1/wallets/:walletId` | Szczegóły walleta (zwraca `walletRole`) |

### 6.5 Addresses (rozszerzone o customerId)

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/chains/:chain/addresses/validate` | Waliduj adres |
| POST | `/v1/wallets/:walletId/addresses` | Zarejestruj adres (opcjonalne: `customerId`, `addressRole`) |
| GET | `/v1/wallets/:walletId/addresses` | Lista adresów walleta |
| POST | `/v1/monitors/addresses` | Dodaj adres do monitoringu (opcjonalne: `customerId`) |
| GET | `/v1/monitors/addresses` | Lista monitorowanych adresów |
| DELETE | `/v1/monitors/addresses/:monitorId` | Usuń monitoring |

### 6.6 Balances

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/chains/:chain/addresses/:address/balances` | Saldo adresu |
| GET | `/v1/chains/:chain/addresses/:address/balances/:asset` | Saldo adresu dla assetu |
| GET | `/v1/wallets/:walletId/balances` | Saldo walleta |

### 6.7 UTXO & Bitcoin-specific

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/chains/bitcoin/addresses/:address/utxos` | UTXO adresu |
| GET | `/v1/wallets/:walletId/utxos` | UTXO walleta |
| GET | `/v1/chains/bitcoin/fees` | Estymacja fee |
| POST | `/v1/chains/bitcoin/transactions/coin-selection` | Coin selection preview |
| POST | `/v1/chains/bitcoin/transactions/prepare` | Przygotuj unsigned tx / PSBT |
| POST | `/v1/chains/bitcoin/transactions/finalize` | Finalizuj podpisany PSBT |
| POST | `/v1/chains/bitcoin/transactions/broadcast` | Broadcast raw tx (BTC-alias) |

### 6.8 Generic transactions

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/chains/:chain/transactions/:txHash` | Szczegóły transakcji |
| GET | `/v1/chains/:chain/transactions/:txHash/status` | Status transakcji |
| POST | `/v1/chains/:chain/transactions/broadcast` | Broadcast raw tx |
| POST | `/v1/chains/:chain/transactions/validate` | Waliduj raw tx |

### 6.9 Payment requests (rozszerzone o customerId)

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/payment-requests` | Utwórz payment request (opcjonalne: `customerId`) |
| GET | `/v1/payment-requests` | Lista payment requestów |
| GET | `/v1/payment-requests/:paymentRequestId` | Szczegóły payment requestu |
| POST | `/v1/payment-requests/:paymentRequestId/cancel` | Anuluj payment request |
| GET | `/v1/payment-requests/by-reference/:reference` | Szukaj po referencji |
| GET | `/v1/payment-requests/:paymentRequestId/qr` | QR payload |

### 6.10 Deposits (rozszerzone o filtr customerId)

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/deposits` | Lista depozytów (filtr: `customerId`) |
| GET | `/v1/deposits/:depositId` | Szczegóły depozytu |
| GET | `/v1/chains/:chain/addresses/:address/deposits` | Depozyty dla adresu |

### 6.11 Ledger (rozszerzone o filtr customerId)

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/ledger/accounts` | Utwórz konto ledgerowe |
| GET | `/v1/ledger/accounts` | Lista kont (filtr: `customerId`) |
| GET | `/v1/ledger/accounts/:ledgerAccountId` | Szczegóły konta |
| GET | `/v1/ledger/accounts/:ledgerAccountId/balances` | Saldo konta |
| GET | `/v1/ledger/accounts/:ledgerAccountId/entries` | Historia konta |
| POST | `/v1/ledger/transfers` | Transfer wewnętrzny |

### 6.12 Webhooks (bez zmian, tenant-scoped)

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/webhooks` | Utwórz webhook |
| GET | `/v1/webhooks` | Lista webhooków |
| GET | `/v1/webhooks/:webhookId` | Szczegóły webhooka |
| PATCH | `/v1/webhooks/:webhookId` | Aktualizuj webhook |
| DELETE | `/v1/webhooks/:webhookId` | Usuń webhook |
| POST | `/v1/webhooks/:webhookId/test` | Testuj webhook |
| GET | `/v1/webhook-deliveries` | Historia deliveries |
| POST | `/v1/webhook-deliveries/:deliveryId/retry` | Ponów delivery |

### 6.13 Withdrawals (wypłaty klientów)

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/withdrawals` | Utwórz żądanie wypłaty |
| GET | `/v1/withdrawals` | Lista wypłat tenanta. Query param `customerId` filtruje po konkretnym kliencie; RBAC: aktor bez dostępu do klienta otrzyma 404. |
| GET | `/v1/withdrawals/:withdrawalId` | Szczegóły wypłaty |
| POST | `/v1/withdrawals/:withdrawalId/submit-signed` | Wyślij podpisaną transakcję (manual signing) |

### 6.14 External Signers (zewnętrzne sygnatariusze)

Protokół integracji z zewnętrznym signerem (OSS/Enterprise daemon). Signer polling-based — sam pobiera zadania.

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/external-signers/enroll` | Rejestracja sygnatariusza |
| GET | `/v1/external-signers` | Lista signerów tenanta |
| GET | `/v1/external-signers/policies` | Polityki decyzji (auto/manual thresholds) |
| PUT | `/v1/external-signers/policies` | Aktualizuj polityki |
| GET | `/v1/external-signers/:signerId` | Szczegóły sygnatariusza |
| PATCH | `/v1/external-signers/:signerId` | Aktualizuj sygnatariusza |
| POST | `/v1/external-signers/:signerId/enable` | Aktywuj sygnatariusza |
| POST | `/v1/external-signers/:signerId/disable` | Dezaktywuj sygnatariusza |
| DELETE | `/v1/external-signers/:signerId` | Usuń rejestrację |
| POST | `/v1/external-signers/:signerId/heartbeat` | Heartbeat (wywoływany przez signer daemon) |
| GET | `/v1/external-signers/:signerId/tasks` | Pobierz nowe zadania podpisywania (polling) |
| POST | `/v1/external-signers/:signerId/tasks/:taskId/claim` | Zarezerwuj zadanie |
| POST | `/v1/external-signers/:signerId/tasks/:taskId/submit` | Prześlij podpisaną transakcję |
| POST | `/v1/external-signers/:signerId/tasks/:taskId/reject` | Odrzuć zadanie z kodem błędu |

### 6.15 Signing Tasks (zadania podpisywania — widok operatora)

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/signing-tasks` | Lista zadań podpisywania tenanta |
| GET | `/v1/signing-tasks/:taskId` | Szczegóły zadania |
| POST | `/v1/signing-tasks/:taskId/approve` | Zatwierdź zadanie oczekujące na akceptację |
| POST | `/v1/signing-tasks/:taskId/reject` | Odrzuć zadanie (manual review) |

### 6.16 Withdrawal Batches (partie wypłat BTC)

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/withdrawal-batches` | Lista partii wypłat |
| GET | `/v1/withdrawal-batches/:batchId` | Szczegóły partii |
| POST | `/v1/withdrawal-batches/:batchId/approve` | Zatwierdź partię (manual mode) |
| POST | `/v1/withdrawal-batches/:batchId/reject` | Odrzuć partię |
| POST | `/v1/withdrawal-batches/:batchId/retry` | Ponów budowanie partii |
| POST | `/v1/withdrawal-batches/:batchId/cancel` | Anuluj partię |
| POST | `/v1/withdrawal-batches/:batchId/rbf-bump` | Zastąp stuck TX wyższą opłatą (RBF) |
| POST | `/v1/withdrawal-batches/:batchId/cpfp` | Utwórz transakcję CPFP dla odblokowania |
| GET | `/v1/tenant/withdrawal-batch-config` | Konfiguracja batchowania tenanta |
| PATCH | `/v1/tenant/withdrawal-batch-config` | Aktualizuj konfigurację batchowania |

---

## 7. Statusy (bez zmian)

### Payment request statusy

| Status | Opis |
|--------|------|
| `created` | Utworzony, adres przypisany |
| `pending` | Aktywny, czeka na płatność |
| `detected` | Transakcja wykryta w mempolu (0-conf) |
| `partially_paid` | Kwota częściowa wykryta |
| `overpaid` | Nadpłata |
| `paid` | Opłacony z wymaganymi potwierdzeniami |
| `expired` | Wygasł bez płatności |
| `cancelled` | Anulowany przez klienta |
| `failed` | Błąd systemu |

### Deposit statusy

| Status | Opis |
|--------|------|
| `detected` | Wykryty w mempolu (0-conf) |
| `pending_confirmation` | W bloku, ale poniżej wymaganego progu |
| `confirmed` | Wymagana liczba potwierdzeń osiągnięta |
| `finalized` | Uznany za finalny (6+ potwierdzeń) |
| `reorged` | Reorganizacja blockchain — transakcja usunięta z łańcucha |
| `failed` | Błąd przetwarzania |

### Transaction statusy

| Status | Opis |
|--------|------|
| `prepared` | PSBT/raw tx przygotowana, niezbroadcastowana |
| `signed` | Podpisana przez klienta |
| `broadcasted` | Wysłana do sieci |
| `seen_in_mempool` | Potwierdzona obecność w mempolu |
| `confirmed` | W bloku z wymaganą liczbą potwierdzeń |
| `failed` | Odrzucona lub błąd |
| `dropped` | Wypadła z mempolu bez potwierdzenia |
| `replaced` | Zastąpiona inną transakcją (RBF) |

### Webhook delivery statusy

| Status | Opis |
|--------|------|
| `pending` | Oczekuje na dostarczenie |
| `sent` | Dostarczona (HTTP 2xx od odbiorcy) |
| `failed` | Wszystkie próby wyczerpane |
| `retrying` | Oczekuje na retry |

### Tenant statusy

| Status | Opis |
|--------|------|
| `active` | Aktywny, wszystkie operacje dozwolone |
| `suspended` | Zawieszony przez operatora — żądania odrzucane z 403 |
| `disabled` | Trwale wyłączony |

### Customer statusy

| Status | Opis |
|--------|------|
| `active` | Aktywny |
| `disabled` | Dezaktywowany przez tenanta |
| `frozen` | Zamrożony (np. podejrzenie nadużycia) |

### Customer withdrawal statusy

| Status | Opis |
|--------|------|
| `queued` | Oczekuje na przetworzenie przez batcher |
| `batched` | Przypisana do partii — PSBT w budowie |
| `pending_signature` | Partia przekazana do sygnatariusza |
| `signed` | Podpisana — oczekuje na broadcast |
| `broadcast` | Transakcja wyemitowana do sieci |
| `confirmed` | Transakcja potwierdzona on-chain |
| `failed` | Błąd przetwarzania |
| `cancelled` | Anulowana przed batczowaniem |

### Withdrawal batch statusy

| Status | Opis |
|--------|------|
| `building` | Partia jest budowana (coin selection, PSBT) |
| `pending_approval` | Oczekuje na ręczne zatwierdzenie przez operatora |
| `pending_signature` | Przekazana do zewnętrznego sygnatariusza |
| `signed` | PSBT podpisana — gotowa do broadcast |
| `broadcast` | Transakcja wyemitowana do sieci |
| `confirmed` | Transakcja potwierdzona on-chain |
| `failed` | Błąd (coin selection, signing, broadcast) |
| `cancelled` | Anulowana przez operatora |
| `replaced` | Zastąpiona nową transakcją (RBF bump) |

---

## 8. Confirmation policy

### Bitcoin — per-tenant

v2 przenosi konfigurację z `.env` na poziom tenant:

- `tenant_configs.btc_confirmations_required` — domyślna polityka dla tenanta (domyślnie 1).
- `tenant_configs.btc_finality_confirmations` — próg finality (domyślnie 6).
- Payment request może mieć własne `confirmationsRequired` (override per-request).
- `detected` = transakcja w mempolu (0 confirmations).
- `pending_confirmation` = w bloku, ale poniżej progu.
- `confirmed` = wymagana liczba confirmations osiągnięta.
- `finalized` = próg finality osiągnięty.

Globalne wartości domyślne nadal przez `.env` (jako fallback przy tworzeniu tenant_config):

```
BTC_DEFAULT_CONFIRMATIONS=1
BTC_FINALITY_CONFIRMATIONS=6
```

Per-request override w payment request body:

```json
{
  "confirmationsRequired": 3
}
```

### Przyszłość (Ethereum)

Dla EVM: `included` → `safe` → `finalized` według beacon chain slots. Konfigurowalne per-chain w tabeli `chains`.

---

## 9. Bezpieczeństwo

### 9.1 Multi-tenant middleware (nowe)

```
Request → Tenant Auth middleware:
  1. Wyciągnij Bearer token z nagłówka Authorization
  2. SHA-256(token) → lookup api_keys WHERE key_hash = ?
  3. Zweryfikuj: is_active = 1 AND (expires_at IS NULL OR expires_at > now())
  4. Wczytaj tenant_id z api_key
  5. Wczytaj tenanta: SELECT * FROM tenants WHERE id = tenant_id
  6. Zweryfikuj: tenant.status = 'active' (w przeciwnym razie 403)
  7. Zapisz last_used_at
  8. Dołącz tenant_id do kontekstu żądania (req.tenantId)
  9. Wszystkie kolejne zapytania MUSZĄ zawierać WHERE tenant_id = ?
```

### 9.2 Admin middleware (nowe)

```
Request → Admin auth middleware:
  1. Wyciągnij X-Admin-Key header
  2. SHA-256(key) → lookup admin_keys WHERE key_hash = ?
  3. Zweryfikuj: is_active = 1
  4. Brak tenant_id — może operować na wszystkich tenantach
  5. Dostępne wyłącznie dla /admin/v1/* endpointów
```

### 9.3 Cross-tenant isolation (krytyczne)

Krytyczne miejsca, które MUSZĄ filtrować po tenant_id:

- **UTXO coin selection:** `WHERE tenant_id = ? AND is_locked = 0 AND is_spent = 0`
- **Deposit lookup:** `WHERE tenant_id = ?`
- **Ledger operations:** `WHERE tenant_id = ?`
- **Webhook delivery:** `WHERE tenant_id = ?`
- **Address registration:** wallet.tenant_id MUSI być równe request.tenantId
- **Customer queries:** `WHERE tenant_id = ?`
- **Payment request queries:** `WHERE tenant_id = ?`
- **Transaction queries:** `WHERE tenant_id = ?`

### 9.4 API Keys (zaktualizowane)

- Każde żądanie wymaga `Authorization: Bearer <api_key>`.
- Klucze przechowywane jako SHA-256 hash w tabeli `api_keys`.
- `api_keys` ma `tenant_id` — każdy klucz należy do jednego tenanta.
- Seed generuje domyślnego tenanta i API key (`API_KEY` w `.env`).
- Admin keys przechowywane w osobnej tabeli `admin_keys` — bez tenant_id.
- Endpoint `/health` jest publiczny.

### 9.5 Idempotency Keys (zaktualizowane)

- Header `Idempotency-Key: <uuid>` dla POST operacji.
- Klucze są scoped do tenant_id: `PRIMARY KEY (tenant_id, key, operation)`.
- Wyniki przechowywane 24h.
- Ponowne żądanie z tym samym kluczem (tego samego tenanta) zwraca identyczny wynik.

### 9.6 Rate Limiting

- In-process rate limiting przez sliding window counter w pamięci.
- Konfigurowalny limit per API key (domyślnie 100 req/min).
- Nie wymaga Redis.

### 9.7 Request Validation

- Walidacja wejścia przez `zod` dla wszystkich body i query params.
- Sanityzacja adresów BTC przed przekazaniem do Bitcoin Core.

### 9.8 Webhook Signatures HMAC

- Każdy webhook delivery podpisany HMAC-SHA256.
- Headers: `X-CryptoApi-Signature`, `X-CryptoApi-Timestamp`, `X-CryptoApi-Event-Id`.
- Podpis obliczany z `timestamp + "." + payload`.
- Secret per-tenant (w `tenant_configs.webhook_secret` lub per-webhook w `webhooks.secret`).

### 9.9 Brak kluczy prywatnych

- API nigdy nie prosi o klucze prywatne.
- API nigdy nie przechowuje seeds ani private keys.
- Klient podpisuje transakcje samodzielnie, API tylko broadcastuje.

### 9.10 Bitcoin Core RPC

- Nigdy nie wystawiony publicznie — wyłącznie połączenie wewnętrzne.
- Konfiguracja przez `.env` (`BITCOIN_RPC_URL` etc.).
- Basic auth przez HTTP.

### 9.11 SQLite

- Plik bazy danych powinien mieć uprawnienia `600`.
- Backup przez skopiowanie pliku podczas niskiej aktywności.
- Konfigurowalny path przez `SQLITE_DB_PATH`.

### 9.12 Sekrety

- Wszystkie sekrety przez `.env` (nigdy w kodzie).
- `.env` w `.gitignore`.

---

## 10. Lekki tryb działania (bez zmian)

```
┌─────────────────────────────┐
│  Jeden serwer               │
│                             │
│  ┌─────────────────────┐   │
│  │  Node.js process    │   │
│  │  Express API        │   │
│  │  + Workers          │   │
│  └────────┬────────────┘   │
│           │                 │
│  ┌────────▼────────────┐   │
│  │  crypto-api.sqlite  │   │
│  └─────────────────────┘   │
│                             │
│  ┌─────────────────────┐   │
│  │  Bitcoin Core node  │   │
│  │  (local or remote)  │   │
│  └─────────────────────┘   │
└─────────────────────────────┘
```

### Przenośność

Przeniesienie na inny serwer wymaga tylko:

1. Skopiowanie katalogu aplikacji: `cp -r engine/ newserver:/opt/chain-api/`
2. Skopiowanie `.env`: `cp .env newserver:/opt/chain-api/`
3. Skopiowanie pliku SQLite: `cp data/crypto-api.sqlite newserver:/opt/chain-api/data/`
4. Wskazanie Bitcoin Core RPC w `.env` (`BITCOIN_RPC_URL`)
5. `npm install && npm run db:migrate && npm start`

### Trade-offs — dlaczego SQLite i in-process workers są OK dla bety

**SQLite:**
- Doskonały dla jednego serwera, małego ruchu, szybkiego startu.
- Łatwy backup/restore — jeden plik.
- WAL mode umożliwia równoległe odczyty przy jednym piśmie.
- Ograniczenie: brak HA, brak replikacji, brak multi-writer.
- **Ścieżka migracji:** Postgres z identycznym schematem. Kod query layer można zamienić z minimalną modyfikacją.

**In-process workers:**
- Brak zależności zewnętrznych, prosta konfiguracja.
- Wystarczające dla małego/średniego wolumenu transakcji.
- Ograniczenie: nie skaluje na wiele procesów, brak priority queues.
- **Ścieżka migracji:** BullMQ + Redis lub dedykowany worker process z tą samą tabelą `jobs` jako backlogiem.

---

## 11. Event types

### Zachowane z v1

```
payment_request.created
payment_request.detected
payment_request.paid
payment_request.expired
payment_request.cancelled
deposit.detected
deposit.confirmed
deposit.finalized
transaction.broadcasted
transaction.confirmed
transaction.failed
```

### Nowe w v2

```
customer.created
customer.disabled
tenant.config_changed
tenant.api_key_created
```

---

## 12. Plan implementacji v2

Opieramy się na fazach z v1 (1–10), poprzedzone fazą 0 z fundamentem multi-tenancy.

### Faza 0 — Multi-tenant foundation (przed resztą)

**0a.** Nowe tabele: `tenants`, `tenant_configs`, `customers`, `admin_keys`

**0b.** Migracja istniejących tabel: dodanie `tenant_id`, `customer_id` (jako NULL-able w migracji, NOT NULL po seed default tenant)

```
wallets          → + tenant_id
addresses        → + tenant_id, customer_id, address_role
watched_addresses → + tenant_id, customer_id
payment_requests → + tenant_id, customer_id
deposits         → + tenant_id, customer_id
transactions     → + tenant_id
cached_utxos     → + tenant_id, customer_id, is_locked, wallet_role
ledger_accounts  → + tenant_id, customer_id, account_type
ledger_entries   → + tenant_id
webhooks         → + tenant_id
webhook_deliveries → + tenant_id
api_keys         → + tenant_id
idempotency_keys → + tenant_id (zmiana PRIMARY KEY)
jobs             → + tenant_id (NULL-able)
```

**0c.** Seed: default tenant + default admin key + przeniesienie istniejącego API key do default tenant

**0d.** Admin middleware (`X-Admin-Key` → `admin_keys`)

**0e.** Admin endpoints: `POST /admin/v1/tenants`, `GET /admin/v1/tenants`, `GET /admin/v1/tenants/:id`, `PATCH /admin/v1/tenants/:id`, `POST /admin/v1/tenants/:id/api-keys`, `POST /admin/v1/tenants/:id/disable`

**0f.** Tenant auth middleware (Bearer → key_hash → tenant_id lookup + tenant status check)

**0g.** Customer API: CRUD + `/balances` + `/deposits` + `/addresses`

### Fazy 1–10 (zmodyfikowane)

Wszystkie fazy z v1 implementowane tak jak opisano w `HLD.md`, ale z rozszerzeniami:

- **Faza 1:** Migracje z `tenant_id` od razu; seed tworzy tenanta zamiast bezpośrednich api_keys.
- **Faza 3:** Rejestracja adresu z opcjonalnym `customer_id`; walidacja wallet.tenant_id == request.tenantId.
- **Faza 4:** Coin selection z obligatoryjnym guardem `WHERE tenant_id = ? AND is_locked = 0 AND is_spent = 0`.
- **Faza 6:** Payment requests i deposits z `tenant_id` + opcjonalnym `customer_id`; filtrowanie po `customerId` query param.
- **Faza 7:** Background workers iterują po aktywnych tenantach; polling per-tenant.
- **Faza 8:** Webhook delivery filtrowany `WHERE tenant_id = ?`; eventy nie przeciekają między tenantami.
- **Faza 9:** Ledger accounts i entries z `tenant_id` + opcjonalnym `customer_id`; filtr `customerId` w GET.
- **Faza 10:** Auth middleware zamieniony na Tenant Context Middleware; idempotency scoped do tenant_id.

---

## Appendix A: watch_only vs external_signer w kontekście multi-tenant

| Tryb | Opis | MVP |
|------|------|-----|
| `watch_only` | Adres zewnętrzny, nie nasz — tylko monitorujemy wpływy | Tak |
| `external_signer` | Nasz adres (z xpub lub zarejestrowany), klucz po stronie klienta | Tak |
| `platform_custody` | Klucze po stronie platformy (HSM/KMS) | Nie — przyszłość |
| `hybrid_custody` | MPC/TSS między klientem a platformą | Nie — przyszłość |

Wallet role `tenant_hot` może być `external_signer`, jeśli tenant sam podpisuje wypłaty. Platforma przygotowuje PSBT z UTXO z wallet_role = `tenant_hot`, klient podpisuje i zwraca do `/broadcast`.

---

## Appendix B: Przyszłość — dodanie Ethereum

Architektura v2 jest zaprojektowana tak, żeby dodanie Ethereum wymagało:

1. Implementacji `EthereumAdapter` implementującego `IChainAdapter`.
2. Dodania migracji dla `chain=ethereum` i assetów ERC-20.
3. Rozszerzenia `transaction/prepare` o EVM transaction format.
4. Dodania `nonce` i `gas` endpoints.
5. Implementacji ERC-20 transfer calldata generation.

Nie wymaga przepisywania:
- Modelu `payment_requests`, `deposits` — chain-agnostic z `tenant_id`.
- Webhook delivery system.
- Ledger.
- Auth, idempotency, multi-tenant middleware.
- Routing `/v1/chains/:chain/...`.
- Customer API.
