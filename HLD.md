# Chain API — High-Level Design (Beta)

## 1. Cel wersji beta

### Co beta robi

- Obsługuje Bitcoin mainnet jako jedyny chain.
- Monitoruje adresy BTC podane przez klienta (watch-only mode, Tryb B).
- Wykrywa depozyty w mempolu i po potwierdzeniach.
- Generuje payment requesty z adresem BTC i QR payload zgodnym z BIP-21.
- Zwraca UTXO dla adresów.
- Szacuje fee (sat/vbyte) przez Bitcoin Core `estimatesmartfee`.
- Przygotowuje unsigned transakcje / PSBT do podpisu przez klienta.
- Broadcastuje gotowe podpisane raw transakcje.
- Obsługuje managed withdrawals przez kolejkę `queued`, batcher BTC, signing tasks i zewnętrzne signery.
- Monitoruje status transakcji w mempolu i po potwierdzeniach.
- Dostarcza minimalne webhooki HMAC-podpisane dla kluczowych zdarzeń.
- Prowadzi minimalny ledger (pending/settled balances) powiązany z depozytami.
- Wymaga autoryzacji API key (`Authorization: Bearer`).
- Obsługuje `Idempotency-Key` dla operacji POST.
- Działa na jednym serwerze jako jeden proces Node.js + SQLite.

### Czego beta świadomie nie robi

- Brak Ethereum, EVM, L2, ERC-20.
- Brak custody: API nie trzyma kluczy prywatnych klientów.
- Brak podpisywania transakcji po stronie API.
- Brak generowania adresów z xpub (Tryb A — zaplanowany jako kolejny krok).
- Brak multisig production flow.
- Brak AML/risk scoring.
- Brak enterprise accounting.
- Brak Postgres / Redis / BullMQ.
- Brak zaawansowanego fee bumping / RBF (zaplanowane jako kolejny krok).
- Brak checkout session (uproszczona warstwa — payment request pełni tę rolę).

---

## 2. Zakres funkcjonalny beta

| Obszar | Status |
|--------|--------|
| Chains/assets metadata | ✅ |
| Wallets | ✅ |
| Address validation | ✅ |
| Address monitoring (watch mode) | ✅ |
| Balances via Bitcoin Core | ✅ |
| UTXO query | ✅ |
| Payment requests | ✅ |
| Deposit detection & confirmation | ✅ |
| Transaction preparation (PSBT/raw) | ✅ |
| Raw tx broadcast | ✅ |
| Transaction status monitoring | ✅ |
| Fee estimation | ✅ |
| Minimal ledger (pending/settled) | ✅ |
| Webhooks (HMAC signed) | ✅ |
| API key auth | ✅ |
| Idempotency keys | ✅ |
| In-process background workers | ✅ |
| SQLite persistence | ✅ |

---

## 3. Zakres poza betą

Poniższe funkcje są świadomie poza zakresem bety i zaplanowane jako następne etapy:

- **Ethereum mainnet** — account-based chain, inne modele transakcji, fee model EIP-1559
- **EVM L2** — Base, Arbitrum One, Optimism, Polygon PoS
- **ERC-20 tokens** — USDC, USDT, DAI, WBTC itd.
- **Custodial signing** — przechowywanie kluczy, podpisywanie po stronie API, HSM
- **Multisig production flow** — BTC P2WSH multisig, EVM smart-contract wallet
- **Application-level approvals** — workflow zatwierdzania, policies
- **Zaawansowane approval workflows** — wieloosobowe zatwierdzanie, quorum, policy UI
- **AML / risk scoring** — integracja z Chainalysis, Elliptic lub innym dostawcą
- **Advanced forensic** — śledzenie przepływu środków, clustering
- **Enterprise accounting** — reconciliation, raportowanie, eksport do systemów ERP
- **Postgres / high availability** — migracja z SQLite dla multi-node i HA
- **Redis / distributed queues** — zewnętrzna kolejka dla wysokiej skali i multi-worker
- **BullMQ** — zaawansowane zarządzanie kolejkami jobów
- **Advanced fee bumping / RBF** — automatyczne przyspieszanie utknietych transakcji
- **Checkout sessions** — multi-asset checkout z konwersją fiat-krypto
- **Address generation z xpub** (Tryb A) — HD deterministic addresses bez kluczy prywatnych

---

## 4. Architektura komponentów

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Express REST API                            │
│  /v1/chains  /v1/wallets  /v1/payment-requests  /v1/deposits  ...  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
┌───────▼──────┐  ┌─────────────▼────────┐  ┌──────────▼───────────┐
│ Business     │  │ Chain Adapter Layer  │  │  SQLite Persistence  │
│ Services     │  │                      │  │  Layer               │
│              │  │  BitcoinAdapter      │  │                      │
│ PaymentReq   │  │  (JSON-RPC)          │  │  better-sqlite3      │
│ Deposit      │  │                      │  │  WAL mode            │
│ Transaction  │  │  EthereumAdapter     │  │  Foreign keys        │
│ Webhook      │  │  (placeholder)       │  │  Integer amounts     │
│ Ledger       │  └──────────────────────┘  └──────────────────────┘
└──────────────┘
        │
┌───────▼──────────────────────────────────────┐
│          In-process Background Workers        │
│                                               │
│  DepositMonitorWorker    (tenant wallet scan) │
│  WebhookDeliveryWorker   (setInterval)        │
│  TxStatusWorker          (setInterval)        │
│  WithdrawalBatcherWorker (multi-batch/run)    │
│  SweepWorker / SweepConfirmationWorker        │
│  SigningTaskExpiryWorker                      │
└───────────────────────────────────────────────┘
        │
┌───────▼──────────────────┐
│  Bitcoin Core Node       │
│  JSON-RPC                │
│  (external, pre-synced)  │
└──────────────────────────┘
```

### Opis komponentów

**Express REST API service** — główny serwer HTTP obsługujący wszystkie endpointy `/v1/...`. Odpowiedzialny za routing, walidację wejścia, autoryzację, idempotencję i formatowanie odpowiedzi.

**SQLite persistence layer** — lokalna baza danych SQLite z WAL mode. Jedyne wymaganie trwałego storage w becie. Brak zewnętrznej bazy.

**Chain adapter layer** — interfejs `IChainAdapter` z metodami niezależnymi od konkretnego chainu. `BitcoinAdapter` implementuje komunikację z Bitcoin Core przez JSON-RPC. `EthereumAdapter` to placeholder z tym samym interfejsem do przyszłej implementacji.

**Payment request service** — zarządza lifecycle payment requestów (created → pending → detected → paid/expired).

**Deposit monitor/indexer** — polling worker skanujący tenantowy FWallet w Bitcoin Core raz na cykl. Wyniki `listunspent` są mapowane do adresów w SQLite i synchronizowane z `cached_utxos`, dzięki czemu koszt nie rośnie liniowo z liczbą adresów.

**Withdrawal batcher** — worker konsumujący `customer_withdrawals.status = queued`, budujący batch PSBT, tworzący signing task i finalizujący batch po podpisie signera.

**Transaction preparation service** — przygotowuje PSBT / unsigned raw tx na podstawie UTXO i outputs. Nie trzyma kluczy.

**Broadcast service** — przyjmuje gotową podpisaną raw tx, waliduje przez `testmempoolaccept`, broadcastuje przez Bitcoin Core.

**Webhook service** — zarządza subskrypcjami i dostarczaniem zdarzeń. HMAC-signed payloads.

**Minimal ledger service** — śledzi saldo pending/settled klientów powiązane z depozytami.

**In-process background workers** — trzy workery uruchamiane jako `setInterval` w tym samym procesie Node.js.

**Migration runner** — sekwencyjne migracje SQLite przez `db:migrate`.

**Configuration loader** — wczytuje `.env` przez `dotenv`, waliduje wymagane zmienne.

---

## 5. Model danych

### Tabela: `chains`

```sql
CREATE TABLE chains (
  id          TEXT PRIMARY KEY,          -- 'bitcoin', 'ethereum'
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,             -- 'utxo' | 'account'
  native_asset TEXT NOT NULL,            -- 'BTC', 'ETH'
  chain_id    INTEGER,                   -- NULL for BTC, 1 for ETH mainnet
  finality_type TEXT NOT NULL,           -- 'confirmations' | 'safe_finalized'
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT,                      -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

### Tabela: `assets`

```sql
CREATE TABLE assets (
  id              TEXT PRIMARY KEY,      -- 'bitcoin:BTC', 'ethereum:USDC'
  chain_id        TEXT NOT NULL REFERENCES chains(id),
  symbol          TEXT NOT NULL,         -- 'BTC', 'USDC'
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,         -- 'native' | 'token'
  contract_address TEXT,                 -- NULL for native, '0x...' for ERC-20
  decimals        INTEGER NOT NULL,      -- 8 for BTC, 6 for USDC, 18 for ETH
  is_enabled      INTEGER NOT NULL DEFAULT 1,
  metadata        TEXT,                  -- JSON
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

### Tabela: `wallets`

```sql
CREATE TABLE wallets (
  id          TEXT PRIMARY KEY,          -- 'wallet_...'
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,             -- 'watch_only' | 'external_signer'
  status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'disabled'
  metadata    TEXT,                      -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

### Tabela: `addresses`

```sql
CREATE TABLE addresses (
  id          TEXT PRIMARY KEY,          -- 'addr_...'
  wallet_id   TEXT NOT NULL REFERENCES wallets(id),
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  address     TEXT NOT NULL,
  label       TEXT,
  address_type TEXT,                     -- 'p2wpkh', 'p2sh', 'p2pkh', 'p2tr'
  status      TEXT NOT NULL DEFAULT 'active',
  metadata    TEXT,                      -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(chain_id, address)
);
```

### Tabela: `watched_addresses`

```sql
CREATE TABLE watched_addresses (
  id          TEXT PRIMARY KEY,          -- 'mon_...'
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  address     TEXT NOT NULL,
  wallet_id   TEXT REFERENCES wallets(id),
  label       TEXT,
  events      TEXT NOT NULL DEFAULT '["incoming"]', -- JSON array
  webhook_id  TEXT REFERENCES webhooks(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT,                      -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(chain_id, address)
);
```

### Tabela: `payment_requests`

```sql
CREATE TABLE payment_requests (
  id                     TEXT PRIMARY KEY,   -- 'payreq_...'
  chain_id               TEXT NOT NULL REFERENCES chains(id),
  asset_id               TEXT NOT NULL REFERENCES assets(id),
  wallet_id              TEXT REFERENCES wallets(id),
  address                TEXT NOT NULL,
  amount_raw             TEXT NOT NULL,      -- satoshi jako string
  amount_display         TEXT NOT NULL,      -- '0.001' BTC
  reference              TEXT,
  status                 TEXT NOT NULL DEFAULT 'created',
  expires_at             TEXT,               -- ISO8601
  confirmations_required INTEGER NOT NULL DEFAULT 1,
  qr_payload             TEXT,              -- BIP-21 URI
  metadata               TEXT,              -- JSON
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
```

### Tabela: `deposits`

```sql
CREATE TABLE deposits (
  id                  TEXT PRIMARY KEY,      -- 'dep_...'
  chain_id            TEXT NOT NULL REFERENCES chains(id),
  asset_id            TEXT NOT NULL REFERENCES assets(id),
  wallet_id           TEXT REFERENCES wallets(id),
  address             TEXT NOT NULL,
  amount_raw          TEXT NOT NULL,         -- satoshi jako string
  amount_display      TEXT NOT NULL,
  tx_hash             TEXT NOT NULL,
  vout                INTEGER,               -- BTC output index
  block_height        INTEGER,               -- NULL if unconfirmed
  block_hash          TEXT,
  confirmations       INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'detected',
  payment_request_id  TEXT REFERENCES payment_requests(id),
  metadata            TEXT,                  -- JSON
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(chain_id, tx_hash, vout)
);
```

### Tabela: `transactions`

```sql
CREATE TABLE transactions (
  id              TEXT PRIMARY KEY,          -- 'tx_...'
  chain_id        TEXT NOT NULL REFERENCES chains(id),
  tx_hash         TEXT,
  raw_tx          TEXT,                      -- hex encoded
  psbt            TEXT,                      -- base64 if PSBT
  status          TEXT NOT NULL DEFAULT 'prepared',
  block_height    INTEGER,
  block_hash      TEXT,
  confirmations   INTEGER NOT NULL DEFAULT 0,
  fee_raw         TEXT,                      -- satoshi
  fee_rate        TEXT,                      -- sat/vbyte
  wallet_id       TEXT REFERENCES wallets(id),
  broadcast_at    TEXT,
  metadata        TEXT,                      -- JSON
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

### Tabela: `cached_utxos`

```sql
CREATE TABLE cached_utxos (
  id              TEXT PRIMARY KEY,          -- 'utxo_...'
  chain_id        TEXT NOT NULL REFERENCES chains(id),
  address         TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  vout            INTEGER NOT NULL,
  amount_raw      TEXT NOT NULL,             -- satoshi
  script_pub_key  TEXT,
  confirmations   INTEGER NOT NULL DEFAULT 0,
  is_spent        INTEGER NOT NULL DEFAULT 0,
  wallet_id       TEXT REFERENCES wallets(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(chain_id, tx_hash, vout)
);
```

### Tabela: `ledger_accounts`

```sql
CREATE TABLE ledger_accounts (
  id          TEXT PRIMARY KEY,              -- 'lacc_...'
  wallet_id   TEXT REFERENCES wallets(id),
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  asset_id    TEXT NOT NULL REFERENCES assets(id),
  name        TEXT NOT NULL,
  metadata    TEXT,                          -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

### Tabela: `ledger_entries`

```sql
CREATE TABLE ledger_entries (
  id                  TEXT PRIMARY KEY,      -- 'lent_...'
  ledger_account_id   TEXT NOT NULL REFERENCES ledger_accounts(id),
  type                TEXT NOT NULL,         -- 'deposit_pending' | 'deposit_settled' | 'withdrawal' | 'transfer_in' | 'transfer_out'
  amount_raw          TEXT NOT NULL,         -- satoshi, signed: positive = credit, negative = debit
  reference_type      TEXT,                  -- 'deposit' | 'transaction' | 'transfer'
  reference_id        TEXT,
  balance_pending_raw  TEXT NOT NULL,        -- running balance pending after entry
  balance_settled_raw  TEXT NOT NULL,        -- running balance settled after entry
  metadata            TEXT,                  -- JSON
  created_at          TEXT NOT NULL
);
```

### Tabela: `webhooks`

```sql
CREATE TABLE webhooks (
  id          TEXT PRIMARY KEY,              -- 'wh_...'
  url         TEXT NOT NULL,
  events      TEXT NOT NULL,                 -- JSON array of event types
  chains      TEXT,                          -- JSON array, NULL = all
  wallet_id   TEXT REFERENCES wallets(id),
  secret      TEXT NOT NULL,                 -- HMAC secret
  is_active   INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT,                          -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

### Tabela: `webhook_deliveries`

```sql
CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,          -- 'wdlv_...'
  webhook_id      TEXT NOT NULL REFERENCES webhooks(id),
  event_id        TEXT NOT NULL,             -- 'evt_...'
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,             -- JSON string
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_retry_at   TEXT,
  delivered_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

### Tabela: `idempotency_keys`

```sql
CREATE TABLE idempotency_keys (
  key         TEXT NOT NULL,
  operation   TEXT NOT NULL,                 -- 'payment_request' | 'broadcast' | 'webhook' | 'ledger_transfer'
  result      TEXT NOT NULL,                 -- JSON serialized response
  status_code INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (key, operation)
);
```

### Tabela: `api_keys`

```sql
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE,          -- SHA-256 hash of actual key
  name        TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT
);
```

### Tabela: `jobs` (opcjonalna, dla retry state)

```sql
CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,                 -- 'deposit_check' | 'webhook_delivery'
  status      TEXT NOT NULL DEFAULT 'pending',
  payload     TEXT NOT NULL,                 -- JSON
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

---

## 6. REST API beta

Pełna lista endpointów z metodami i opisami.

### Health

| Method | Path | Opis |
|--------|------|------|
| GET | `/health` | Sprawdzenie stanu serwera (bez auth) |

### Metadata

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/chains` | Lista chainów |
| GET | `/v1/chains/:chain` | Szczegóły chainu |
| GET | `/v1/assets` | Lista assetów (query: `chain`, `type`) |
| GET | `/v1/chains/:chain/assets/:asset` | Szczegóły assetu |

### Wallets

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/wallets` | Utwórz wallet |
| GET | `/v1/wallets` | Lista walletów |
| GET | `/v1/wallets/:walletId` | Szczegóły walleta |

### Addresses

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/chains/:chain/addresses/validate` | Waliduj adres |
| POST | `/v1/wallets/:walletId/addresses` | Zarejestruj adres w wallecie |
| GET | `/v1/wallets/:walletId/addresses` | Lista adresów walleta |
| POST | `/v1/monitors/addresses` | Dodaj adres do monitoringu |
| GET | `/v1/monitors/addresses` | Lista monitorowanych adresów |
| DELETE | `/v1/monitors/addresses/:monitorId` | Usuń monitoring |

### Balances

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/chains/:chain/addresses/:address/balances` | Saldo adresu |
| GET | `/v1/chains/:chain/addresses/:address/balances/:asset` | Saldo adresu dla assetu |
| GET | `/v1/wallets/:walletId/balances` | Saldo walleta |

### UTXO & Bitcoin-specific

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/chains/bitcoin/addresses/:address/utxos` | UTXO adresu |
| GET | `/v1/wallets/:walletId/utxos` | UTXO walleta |
| GET | `/v1/chains/bitcoin/fees` | Estymacja fee |
| POST | `/v1/chains/bitcoin/transactions/coin-selection` | Coin selection preview |
| POST | `/v1/chains/bitcoin/transactions/prepare` | Przygotuj unsigned tx / PSBT |
| POST | `/v1/chains/bitcoin/transactions/finalize` | Finalizuj podpisany PSBT |
| POST | `/v1/chains/bitcoin/transactions/broadcast` | Broadcast raw tx (BTC-alias) |

### Generic transactions

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/chains/:chain/transactions/:txHash` | Szczegóły transakcji |
| GET | `/v1/chains/:chain/transactions/:txHash/status` | Status transakcji |
| POST | `/v1/chains/:chain/transactions/broadcast` | Broadcast raw tx |
| POST | `/v1/chains/:chain/transactions/validate` | Waliduj raw tx |

### Payment requests

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/payment-requests` | Utwórz payment request |
| GET | `/v1/payment-requests` | Lista payment requestów |
| GET | `/v1/payment-requests/:paymentRequestId` | Szczegóły payment requestu |
| POST | `/v1/payment-requests/:paymentRequestId/cancel` | Anuluj payment request |
| GET | `/v1/payment-requests/by-reference/:reference` | Szukaj po referencji |
| GET | `/v1/payment-requests/:paymentRequestId/qr` | QR payload |

### Deposits

| Method | Path | Opis |
|--------|------|------|
| GET | `/v1/deposits` | Lista depozytów |
| GET | `/v1/deposits/:depositId` | Szczegóły depozytu |
| GET | `/v1/chains/:chain/addresses/:address/deposits` | Depozyty dla adresu |

### Ledger

| Method | Path | Opis |
|--------|------|------|
| POST | `/v1/ledger/accounts` | Utwórz konto ledgerowe |
| GET | `/v1/ledger/accounts` | Lista kont |
| GET | `/v1/ledger/accounts/:ledgerAccountId` | Szczegóły konta |
| GET | `/v1/ledger/accounts/:ledgerAccountId/balances` | Saldo konta |
| GET | `/v1/ledger/accounts/:ledgerAccountId/entries` | Historia konta |
| POST | `/v1/ledger/transfers` | Transfer wewnętrzny |

### Webhooks

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

---

## 7. Statusy

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
| `pending_confirmation` | W bloku, ale poniżej wymaganego prgu |
| `confirmed` | Wymagana liczba potwierdzeń osiągnięta |
| `finalized` | Uznany za finalny (6+ potwierdzeń) |
| `reorged` | Reorganizacja blockchain — transakcja usunięta z łańcucha |
| `failed` | Błąd przetwarzania |

### Transaction statusy

| Status | Opis |
|--------|------|
| `prepared` | PSBT/raw tx przygotowana, niezbroadcastowana |
| `signed` | Podpisana przez klienta (tylko jeśli API zarządza) |
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

---

## 8. Confirmation policy

### Bitcoin

- Domyślna polityka: `1 confirmation` dla wszystkich operacji.
- Payment request może mieć własne `confirmationsRequired` (1–6 typowo).
- `detected` = transakcja w mempolu (0 confirmations).
- `pending_confirmation` = w bloku, ale poniżej progu.
- `confirmed` = wymagana liczba confirmations osiągnięta.
- `finalized` = 6+ confirmations (soft finality dla BTC).

Konfiguracja globalna przez `.env`:

```
BTC_DEFAULT_CONFIRMATIONS=1
BTC_FINALITY_CONFIRMATIONS=6
```

Payment request override:

```json
{
  "confirmationsRequired": 3
}
```

### Przyszłość (Ethereum)

- Dla EVM: `included` → `safe` → `finalized` według beacon chain slots.
- Konfigurowalne per-chain w tabeli `chains`.

---

## 9. Bezpieczeństwo

### API Keys

- Każde żądanie wymaga `Authorization: Bearer <api_key>`.
- Klucze przechowywane jako SHA-256 hash w tabeli `api_keys`.
- Domyślny klucz generowany przy seedzie (`API_KEY` w `.env`).
- Endpoint `/health` jest publiczny.

### Idempotency Keys

- Header `Idempotency-Key: <uuid>` dla POST operacji.
- Wyniki przechowywane 24h w tabeli `idempotency_keys`.
- Ponowne żądanie z tym samym kluczem zwraca identyczny wynik.

### Rate Limiting

- In-process rate limiting przez sliding window counter w pamięci.
- Konfigurowalny limit per API key (domyślnie 100 req/min).
- Nie wymaga Redis.

### Request Validation

- Walidacja wejścia przez `zod` dla wszystkich body i query params.
- Sanityzacja adresów BTC przed przekazaniem do Bitcoin Core.

### Webhook Signatures HMAC

- Każdy webhook delivery podpisany HMAC-SHA256.
- Headers: `X-CryptoApi-Signature`, `X-CryptoApi-Timestamp`, `X-CryptoApi-Event-Id`.
- Podpis obliczany z `timestamp + "." + payload`.

### Brak kluczy prywatnych

- API nigdy nie prosi o klucze prywatne.
- API nigdy nie przechowuje seeds ani private keys.
- Klient podpisuje transakcje samodzielnie, API tylko broadcastuje.

### Bitcoin Core RPC

- Nigdy nie wystawiony publicznie — wyłącznie połączenie wewnętrzne.
- Konfiguracja przez `.env` (`BITCOIN_RPC_URL` etc.).
- Basic auth przez HTTP.

### SQLite

- Plik bazy danych powinien mieć uprawnienia `600` (właściciel tylko).
- Backup przez skopiowanie pliku podczas niskiej aktywności.
- Konfigurowalny path przez `SQLITE_DB_PATH`.

### Sekrety

- Wszystkie sekrety przez `.env` (nigdy w kodzie).
- `.env` w `.gitignore`.

### Audit log

- Operacje broadcast, payment request create/cancel zapisywane z timestampem i API key ID.
- Przechowywane w tabeli `transactions` i `payment_requests` z `created_at`.

---

## 10. Lekki tryb działania

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
- **Ścieżka migracji:** Postgres z identycznym schematem (typy kompatybilne). Kod ORM/query layer można zamienić z minimalną modyfikacją.

**In-process workers:**
- Brak zależności zewnętrznych, prosta konfiguracja.
- Wystarczające dla małego/średniego wolumenu transakcji.
- Ograniczenie: nie skaluje na wiele procesów, brak priority queues.
- **Ścieżka migracji:** BullMQ + Redis lub dedykowany worker process z tą samą tabelą `jobs` jako backlogiem.

---

## 11. Plan implementacji

Implementacja w następującej kolejności:

### Faza 1 — Fundament

1. Inicjalizacja projektu: `package.json`, `tsconfig.json`, struktura katalogów
2. `config/` — wczytywanie `.env`, walidacja wymaganych zmiennych
3. `db/sqlite.ts` — połączenie SQLite, WAL mode, foreign keys
4. `db/migrations/` — wszystkie migracje tabel
5. `db/migrate.ts` — runner migracji
6. `db/seed.ts` — seed `bitcoin/BTC`, domyślny API key
7. `shared/errors/` — klasy błędów, error handler middleware
8. `shared/logging/` — prosty logger
9. `shared/money/` — konwersja satoshi ↔ BTC, arytmetyka integer
10. `app.ts`, `main.ts` — Express setup, middleware, uruchomienie

### Faza 2 — Chain adapter i Bitcoin Core

11. `chain-adapters/types.ts` — interfejs `IChainAdapter`
12. `chain-adapters/bitcoin/rpc-client.ts` — Bitcoin Core JSON-RPC client
13. `chain-adapters/bitcoin/adapter.ts` — implementacja `IChainAdapter`
14. `chain-adapters/ethereum-placeholder/` — stub do przyszłej implementacji
15. `modules/chains/` — routes i service dla GET /v1/chains
16. `modules/assets/` — routes i service dla GET /v1/assets

### Faza 3 — Wallets, addresses, monitoring

17. `modules/wallets/` — CRUD walletów
18. `modules/addresses/` — rejestracja i listowanie adresów, walidacja
19. `shared/validation/bitcoin.ts` — walidacja adresów BTC
20. `modules/addresses/monitor/` — POST /v1/monitors/addresses

### Faza 4 — Balances, UTXO, fees

21. `modules/balances/` — pobieranie sald przez Bitcoin Core
22. `modules/bitcoin/utxos.ts` — pobieranie UTXO
23. `modules/bitcoin/fees.ts` — estymacja fee
24. `modules/bitcoin/coin-selection.ts` — algorytm coin selection

### Faza 5 — Transaction preparation i broadcast

25. `modules/transactions/prepare.ts` — przygotowanie PSBT/raw tx
26. `modules/transactions/broadcast.ts` — broadcast z walidacją
27. `modules/transactions/status.ts` — status transakcji
28. `modules/transactions/validate.ts` — walidacja raw tx

### Faza 6 — Payment requests i deposits

29. `modules/payment-requests/` — pełny CRUD i lifecycle
30. `modules/deposits/` — model i endpoints depozytów

### Faza 7 — Background workers

31. `workers/deposit-monitor.worker.ts` — polling nowych bloków i transakcji
32. `workers/webhook-delivery.worker.ts` — dostarczanie webhooków z retry
33. `workers/tx-status.worker.ts` — aktualizacja statusów transakcji

### Faza 8 — Webhooks

34. `modules/webhooks/` — CRUD webhooków
35. `modules/webhooks/delivery.ts` — wysyłanie eventów HMAC-signed
36. `modules/webhooks/test.ts` — endpoint testowy

### Faza 9 — Ledger

37. `modules/ledger/` — konta, wpisy, transfery wewnętrzne

### Faza 10 — Security i pomocnicze

38. `shared/auth/` — middleware autoryzacji API key
39. `modules/idempotency/` — obsługa `Idempotency-Key`
40. Rate limiting middleware in-process
41. `README.md`, `.env.example`, testy jednostkowe

---

## Appendix: Przyszłość — dodanie Ethereum

Architektura bety jest zaprojektowana tak, żeby dodanie Ethereum wymagało:

1. Implementacji `EthereumAdapter` implementującego `IChainAdapter`.
2. Dodania migrracji dla `chain=ethereum` i assetów ERC-20.
3. Rozszerzenia `transaction/prepare` o EVM transaction format.
4. Dodania `nonce` i `gas` endpoints.
5. Implementacji ERC-20 transfer calldata generation.

Nie wymaga przepisywania:
- Modelu `payment_requests` ani `deposits` — są chain-agnostic.
- Webhook delivery system.
- Ledger.
- Auth, idempotency.
- Routing `/v1/chains/:chain/...` — parametr `:chain` już jest.

Typy obsługiwane przez model domenowy bety:
- `chain.type = "utxo" | "account"` — gotowe
- `asset.type = "native" | "token"` — gotowe
- `asset.contract_address` — gotowe dla ERC-20
- `deposit.vout` — NULL-able, specyficzne dla UTXO
