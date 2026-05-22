# Chain API Engine — wskazówki dla Claude

## Stack

- **Runtime:** Node.js 20+, TypeScript
- **Framework:** Express 4
- **Baza danych:** SQLite (better-sqlite3, WAL mode, foreign keys ON) — jeden plik `data/crypto-api.sqlite`
- **Bitcoin:** Bitcoin Core JSON-RPC (`BitcoinRpcClient`) — brak kluczy prywatnych w silniku
- **MCP:** `@modelcontextprotocol/sdk` — silnik wystawia narzędzia MCP na `/mcp/tenant`, `/mcp/customer`, `/mcp/admin`
- **Walidacja:** `zod` (body + query params)
- **Testy:** Jest + ts-jest + supertest; wszystkie testy w `tests/`
- **Build:** `tsc` → `dist/`; dev przez `ts-node`

## Kluczowe koncepty

- **FWallet** (`btc_{tenantId}`) — portfel watch-only w Bitcoin Core; jeden na tenanta; nie jest widoczny przez API.
- **LWallet** — rekord portfela w bazie chain-api; role: `customer_deposits`, `tenant_hot`, `tenant_cold`, `watch_only`.
- **Tenant** — klient biznesowy platformy; izolacja przez `WHERE tenant_id = ?` we wszystkich zapytaniach SQL.
- **Customer** — końcowy użytkownik tenanta; konstrukt ledgerowy, nie ma własnego FWallet.
- **Ledger** — jedyne źródło prawdy o saldach; Bitcoin Core to infrastruktura chainowa.
- `tenant_id` w tabeli `cached_utxos` + `is_locked` to krytyczna granica bezpieczeństwa — coin selection nigdy nie może przekroczyć granicy tenanta.

## X-Actor-Token — RBAC dla użytkowników tenanta

Każde żądanie do `/v1/*` może opcjonalnie zawierać nagłówek `X-Actor-Token`.

### Dwa tryby dostępu

| Nagłówek | Tryb | Zachowanie |
|----------|------|-----------|
| Brak `X-Actor-Token` | **Admin-all** | Pełny dostęp do wszystkich danych tenanta. Tenant odpowiada za kontrolę kto wywołuje API bez tokena. |
| `X-Actor-Token: <jwt>` | **RBAC** | Prawa dostępu z tokena są wymuszane na poziomie data source (SQL). |

### Format X-Actor-Token (JWT HS256)

```json
{
  "sub": "user_123",
  "tenant_id": "tenant_abc",
  "permissions": ["customers:read:team", "customers:write:assigned"],
  "teams": ["team_warsaw", "team_warsaw_north"],
  "roles": ["sales_agent"],
  "exp": 1716394800,
  "iat": 1716394200
}
```

- **Podpis:** HMAC-SHA256, secret konfigurowany per tenant w `tenant_configs.actor_token_secret`
- **`permissions`:** format `<entity>:<action>:<level>`, np. `customers:read:team`
- **`teams`:** lista teamów aktora — **pre-expanded** przez tenanta, Chain API jej nie rozszerza
- **`roles`:** tylko informacyjne (Chain API ich nie interpretuje — tenant mapuje role→permissiony sam, przed wystawieniem tokena)

### Format permissionów

```
<entity>:<action>:<level>
customers:read:all      — dostęp do wszystkich klientów tenanta
customers:read:team     — dostęp do klientów własnych teamów aktora
customers:read:assigned — dostęp tylko do klientów przypisanych do aktora
customers:write:team    — jak read:team, dla operacji zapisu
```

Priorytet: `all > team > assigned`. Brak pasującego permissiona → `403 INSUFFICIENT_PERMISSIONS`.

### Security envelope encji

Encje chronione (np. `customers`) posiadają pola:

| Pole | Znaczenie |
|------|-----------|
| `owner_user_id` | user który stworzył rekord (`actorContext.actorId` przy create) |
| `owner_team_id` | team aktora przy tworzeniu (`actorContext.teams[0]`) |
| `access_user_ids` | JSON array userów z dodatkowym dostępem |
| `access_team_ids` | JSON array teamów z dodatkowym dostępem |

### Konfiguracja per tenant

```
PATCH /v1/tenant/config
{ "actorTokenSecret": "minimum-32-character-secret-here" }
```

### Moduł `src/shared/actor-auth/`

| Plik | Odpowiedzialność |
|------|-----------------|
| `types.ts` | Typy: `ActorContext`, `AccessFilter`, `Permission`, `SortPolicy`, etc. |
| `verifier.ts` | Weryfikacja JWT (HMAC-SHA256, per-tenant secret) |
| `context.ts` | `resolveActorContext()`, `resolvePermission()` |
| `filter.ts` | `buildAccessFilter()`, `adminAllFilter()` |
| `compiler.ts` | `compileSqliteFilter()` → SQL fragment |
| `query.ts` | `SecuredQuery.for(filter, alias)` — wrapper wymuszający użycie filtra |
| `sort.ts` | `normalizeSort()`, `encodeCursor()`, `decodeCursor()`, `cursorToSql()` |
| `middleware.ts` | Express middleware ustawiający `req.actorContext` |
| `entity-defs.ts` | `CustomerEntityDef` (sort policy, dozwolone pola) |

### Zasady implementacji nowych endpointów na chronionych encjach

1. **Zawsze** użyj `getAccessFilter(req, 'read'|'write')` z routera — rzuca `403` jeśli brak uprawnień.
2. **Zawsze** przekaż `AccessFilter` do serwisu — nigdy nie pomijaj go jako `undefined` w nowych endpointach.
3. **Zawsze** używaj `SecuredQuery.for(filter, alias)` w zapytaniach SQL — `isDenied` → zwróć pusty wynik / 404.
4. Dla write operations: access filter musi być w klauzuli `WHERE` samej operacji `UPDATE/DELETE` (nie tylko w poprzednim SELECT).
5. `getById` z `accessFilter` → 404 dla braku dostępu (nie 403) — nie ujawniamy istnienia rekordu.
6. Przy tworzeniu encji: wypełnij `owner_user_id = ctx?.actorId` i `owner_team_id = ctx?.teams[0]`.

### Dodanie nowej chronionej encji

1. Dodaj security envelope columns w migracji SQL.
2. Dodaj `EntityDefinition` w `entity-defs.ts`.
3. W routerze użyj `getAccessFilter(req, action)` i przekaż `AccessFilter` do serwisu.
4. W serwisie użyj `SecuredQuery.for(filter, alias)` zamiast ręcznego `WHERE tenant_id = ?`.

## Architektura i dokument HLD

**Dokument architektury:** `HLD_v2.md` (obowiązujący) i `HLD.md` (v1 — historyczny).

`HLD_v2.md` jest autorytatywnym dokumentem projektowym. Zawiera:
- Zakres MVP i poza-MVP (sekcje 1–3)
- Diagram komponentów (sekcja 4)
- Schemat bazy danych (sekcja 5) — zawiera wszystkie tabele z DDL
- Kompletne tabele endpointów REST API (sekcja 6)
- Statusy encji (sekcja 7)
- Politykę potwierdzeń (sekcja 8)
- Model bezpieczeństwa i multi-tenant middleware (sekcja 9)
- Typy zdarzeń webhooków (sekcja 11)

### Kiedy aktualizować HLD_v2.md

Aktualizuj HLD_v2.md gdy:
- Dodajesz nowy endpoint → dodaj wiersz do odpowiedniej tabeli w sekcji 6
- Zmieniasz schemat bazy → zaktualizuj DDL w sekcji 5
- Zmieniasz statusy encji → zaktualizuj sekcję 7
- Dodajesz nowy typ zdarzenia webhooka → zaktualizuj sekcję 11
- Zmieniasz zakres MVP (coś przechodzi z „poza betą" do „w becie") → zaktualizuj sekcje 2–3

## Testy

### Struktura

```
tests/
├── unit/                        # testy jednostkowe logiki
│   ├── customers-balances.test.ts
│   ├── jwt.test.ts
│   └── seed-provisioning.test.ts
├── integration/                 # testy integracyjne API
│   ├── helpers.ts               # bootstrapApp(), uniqueAddr(), stałe AUTH/ADMIN_AUTH
│   ├── setup-env.ts             # zmienne środowiskowe dla testów
│   ├── health.test.ts
│   ├── chains-assets.test.ts
│   ├── wallets.test.ts
│   ├── addresses.test.ts
│   ├── bitcoin.test.ts
│   ├── customers.test.ts
│   ├── customer-sessions.test.ts
│   ├── deposits.test.ts
│   ├── ledger.test.ts
│   ├── ledger-flows.test.ts
│   ├── mcp.test.ts
│   ├── payment-requests.test.ts
│   ├── tenant-isolation.test.ts  # cross-tenant security
│   ├── tenant-self.test.ts
│   ├── tenants.test.ts
│   ├── webhooks.test.ts
│   ├── gap1-ledger-provisioning.test.ts
│   ├── gap2-sweeps.test.ts
│   └── gap3-deposit-address.test.ts
├── bitcoin-validation.test.ts
├── idempotency.test.ts
└── money.test.ts
```

### Konwencje testów

- Każdy plik testowy woła `bootstrapApp()` z `helpers.ts` — tworzy świeżą bazę SQLite in-memory (`:memory:`)
- `bootstrapApp()` jest wywoływane raz per plik, nie per test (izolacja przez osobną bazę per plik)
- `uniqueAddr()` generuje unikalne adresy BTC mainnet z xpub — używaj zamiast harcoded adresów gdy test potrzebuje unikatowego adresu
- Testy integracyjne nie mocują Bitcoin Core — komendy RPC są mocowane przez `.env.test` lub service-level stubs
- `afterAll(() => teardownDb())` — obowiązkowe w każdym pliku testowym
- Uruchomienie: `npm test` (Jest `--runInBand --forceExit`)

### Kiedy pisać testy

- Nowy endpoint REST → dodaj przypadki w odpowiednim pliku `tests/integration/*.test.ts`
- Nowa logika biznesowa (kalkulacje sald, walidacja) → dodaj test jednostkowy w `tests/unit/`
- Nowa izolacja tenant/security → dodaj przypadek w `tests/integration/tenant-isolation.test.ts`
- Gap testy (gap1, gap2, gap3) → pokrywają scenariusze E2E, dodawaj tam gdy testujesz pełne przepływy

## Kolekcja Postman

Kolekcja Postman (jeśli istnieje) odzwierciedla aktualny stan API.

**Aktualizuj kolekcję Postman gdy:**
- Dodajesz nowy endpoint
- Zmieniasz body/query/path parametry istniejącego endpointu
- Zmieniasz format odpowiedzi
- Zmieniasz wymagania autoryzacji

Jeśli kolekcja nie istnieje, zaproponuj jej utworzenie przy pierwszej okazji dodawania endpointów.

## Tabela statusów endpointów API

Utrzymuj tę tabelę aktualną. Kolumny:
- **MVP**: ✅ zaimplementowany | ❌ brak | 🚧 w toku
- **Testy**: ✅ pokryty | ⚠️ częściowy | ❌ brak
- **MCP**: ✅ wystawiony jako narzędzie MCP | ❌ tylko REST

> Przy każdej zmianie endpointu (add/modify/remove) zaktualizuj odpowiedni wiersz poniżej.

### Health & MCP

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/health` | ✅ | ✅ | ❌ |
| POST | `/mcp/tenant` | ✅ | ✅ | — |
| POST | `/mcp/customer` | ✅ | ✅ | — |
| POST | `/mcp/admin` | ✅ | ✅ | — |

### Admin API (`X-Admin-Key`)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/admin/v1/tenants` | ✅ | ✅ | ✅ `chainapi_admin_create_tenant` |
| GET | `/admin/v1/tenants` | ✅ | ✅ | ✅ `chainapi_admin_list_tenants` |
| GET | `/admin/v1/tenants/:tenantId` | ✅ | ✅ | ❌ |
| PATCH | `/admin/v1/tenants/:tenantId` | ✅ | ✅ | ❌ |
| GET | `/admin/v1/tenants/:tenantId/config` | ✅ | ✅ | ❌ |
| PATCH | `/admin/v1/tenants/:tenantId/config` | ✅ | ✅ | ❌ |
| POST | `/admin/v1/tenants/:tenantId/api-keys` | ✅ | ✅ | ✅ `chainapi_admin_create_tenant_api_key` |
| POST | `/admin/v1/tenants/:tenantId/disable` | ✅ | ✅ | ❌ |

### Tenant self-service (`Bearer <api-key>`)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/tenant` | ✅ | ✅ | ✅ `chainapi_get_tenant` |
| PATCH | `/v1/tenant` | ✅ | ✅ | ❌ |
| GET | `/v1/tenant/config` | ✅ | ✅ | ❌ |
| PATCH | `/v1/tenant/config` | ✅ | ✅ | ❌ |

### Customers

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/customers` | ✅ | ✅ | ✅ `chainapi_create_customer` |
| GET | `/v1/customers` | ✅ | ✅ | ✅ `chainapi_list_customers` |
| GET | `/v1/customers/:customerId` | ✅ | ✅ | ✅ `chainapi_get_customer` |
| PATCH | `/v1/customers/:customerId` | ✅ | ✅ | ✅ `chainapi_update_customer` |
| POST | `/v1/customers/:customerId/disable` | ✅ | ✅ | ✅ `chainapi_disable_customer` |
| GET | `/v1/customers/:customerId/balances` | ✅ | ✅ | ✅ `chainapi_get_customer_balances` |
| GET | `/v1/customers/:customerId/deposits` | ✅ | ✅ | ✅ `chainapi_list_customer_deposits` |
| GET | `/v1/customers/:customerId/addresses` | ✅ | ✅ | ✅ `chainapi_list_customer_addresses` |
| POST | `/v1/customers/:customerId/sessions` | ✅ | ✅ | ✅ `chainapi_create_customer_session` |
| POST | `/v1/customers/:customerId/deposit-address` | ✅ | ✅ | ✅ `chainapi_create_customer_deposit_address` |
| GET | `/v1/customers/:customerId/profile` | ✅ | ✅ | ✅ `chainapi_get_customer_profile` |
| PUT | `/v1/customers/:customerId/profile` | ✅ | ✅ | ✅ `chainapi_upsert_customer_profile` |
| GET | `/v1/customers/:customerId/identifiers` | ✅ | ✅ | ✅ `chainapi_list_customer_identifiers` |
| POST | `/v1/customers/:customerId/identifiers` | ✅ | ✅ | ✅ `chainapi_add_customer_identifier` |
| PATCH | `/v1/customers/:customerId/identifiers/:identifierId` | ✅ | ✅ | ✅ `chainapi_update_customer_identifier` |
| DELETE | `/v1/customers/:customerId/identifiers/:identifierId` | ✅ | ✅ | ✅ `chainapi_delete_customer_identifier` |
| GET | `/v1/customers/:customerId/relationships` | ✅ | ✅ | ✅ `chainapi_list_customer_relationships` |
| POST | `/v1/customers/:customerId/relationships` | ✅ | ✅ | ✅ `chainapi_add_customer_relationship` |
| PATCH | `/v1/customers/:customerId/relationships/:relId` | ✅ | ✅ | ✅ `chainapi_update_customer_relationship` |
| DELETE | `/v1/customers/:customerId/relationships/:relId` | ✅ | ✅ | ✅ `chainapi_delete_customer_relationship` |
| GET | `/v1/customers/:customerId/aml-kyc` | ✅ | ✅ | ✅ `chainapi_get_customer_aml_kyc` |
| PUT | `/v1/customers/:customerId/aml-kyc` | ✅ | ✅ | ✅ `chainapi_upsert_customer_aml_kyc` |
| GET | `/v1/customers/:customerId/data-governance` | ✅ | ✅ | ✅ `chainapi_get_customer_data_governance` |
| PUT | `/v1/customers/:customerId/data-governance` | ✅ | ✅ | ✅ `chainapi_upsert_customer_data_governance` |
| GET | `/v1/customers/:customerId/contact` | ✅ | ✅ | ✅ `chainapi_get_customer_contact` |
| PUT | `/v1/customers/:customerId/contact` | ✅ | ✅ | ✅ `chainapi_upsert_customer_contact` |
| GET | `/v1/customers/:customerId/documents` | ✅ | ✅ | ✅ `chainapi_list_customer_documents` |
| POST | `/v1/customers/:customerId/documents` | ✅ | ✅ | ✅ `chainapi_add_customer_document` |
| PATCH | `/v1/customers/:customerId/documents/:documentId` | ✅ | ✅ | ✅ `chainapi_update_customer_document` |
| DELETE | `/v1/customers/:customerId/documents/:documentId` | ✅ | ✅ | ✅ `chainapi_delete_customer_document` |

### Customer self-service — `/v1/me` (`Bearer <customer-jwt>`)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/me` | ✅ | ✅ | ✅ `chainapi_me_get_profile` |
| GET | `/v1/me/balances` | ✅ | ⚠️ | ✅ `chainapi_me_get_balances` |
| GET | `/v1/me/deposits` | ✅ | ⚠️ | ✅ `chainapi_me_list_deposits` |
| GET | `/v1/me/addresses` | ✅ | ✅ | ✅ `chainapi_me_list_addresses` |
| POST | `/v1/me/deposit-address` | ✅ | ✅ | ✅ `chainapi_me_create_deposit_address` |
| POST | `/v1/me/withdrawals` | ✅ | ✅ | ✅ `chainapi_me_create_withdrawal` |
| GET | `/v1/me/withdrawals` | ✅ | ✅ | ✅ `chainapi_me_list_withdrawals` |
| GET | `/v1/me/withdrawals/:withdrawalId` | ✅ | ✅ | ✅ `chainapi_me_get_withdrawal` |
| GET | `/v1/me/profile` | ✅ | ✅ | ✅ `chainapi_me_get_kyc_profile` |
| PUT | `/v1/me/profile` | ✅ | ✅ | ✅ `chainapi_me_upsert_kyc_profile` |
| GET | `/v1/me/contact` | ✅ | ✅ | ✅ `chainapi_me_get_contact` |
| PUT | `/v1/me/contact` | ✅ | ✅ | ✅ `chainapi_me_upsert_contact` |
| GET | `/v1/me/kyc-status` | ✅ | ✅ | ✅ `chainapi_me_get_kyc_status` |
| GET | `/v1/me/documents` | ✅ | ✅ | ✅ `chainapi_me_list_documents` |
| POST | `/v1/me/documents` | ✅ | ✅ | ✅ `chainapi_me_upload_document` |

### Chains & Assets

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/chains` | ✅ | ✅ | ❌ |
| GET | `/v1/chains/:chain` | ✅ | ✅ | ❌ |
| GET | `/v1/assets` | ✅ | ✅ | ❌ |
| GET | `/v1/chains/:chain/assets/:asset` | ✅ | ✅ | ❌ |

### Wallets

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/wallets` | ✅ | ✅ | ❌ |
| GET | `/v1/wallets` | ✅ | ✅ | ❌ |
| GET | `/v1/wallets/:walletId` | ✅ | ✅ | ❌ |

### Addresses

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/chains/:chain/addresses/validate` | ✅ | ✅ | ❌ |
| POST | `/v1/wallets/:walletId/addresses` | ✅ | ✅ | ❌ |
| GET | `/v1/wallets/:walletId/addresses` | ✅ | ✅ | ❌ |
| POST | `/v1/monitors/addresses` | ✅ | ✅ | ❌ |
| GET | `/v1/monitors/addresses` | ✅ | ✅ | ❌ |
| DELETE | `/v1/monitors/addresses/:monitorId` | ✅ | ⚠️ | ❌ |

### Balances

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/chains/:chain/addresses/:address/balances` | ✅ | ✅ | ❌ |
| GET | `/v1/chains/:chain/addresses/:address/balances/:asset` | ✅ | ⚠️ | ❌ |
| GET | `/v1/wallets/:walletId/balances` | ✅ | ✅ | ❌ |

### UTXOs & Fees

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/chains/bitcoin/addresses/:address/utxos` | ✅ | ✅ | ❌ |
| GET | `/v1/wallets/:walletId/utxos` | ✅ | ✅ | ❌ |
| GET | `/v1/chains/bitcoin/fees` | ✅ | ✅ | ❌ |

### Transactions (Bitcoin-specific)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/chains/bitcoin/transactions/coin-selection` | ✅ | ✅ | ❌ |
| POST | `/v1/chains/bitcoin/transactions/prepare` | ✅ | ✅ | ❌ |
| POST | `/v1/chains/bitcoin/transactions/finalize` | ✅ | ✅ | ❌ |
| POST | `/v1/chains/bitcoin/transactions/broadcast` | ✅ | ✅ | ❌ |

### Transactions (generic)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/chains/:chain/transactions/:txHash` | ✅ | ⚠️ | ❌ |
| GET | `/v1/chains/:chain/transactions/:txHash/status` | ✅ | ⚠️ | ❌ |
| POST | `/v1/chains/:chain/transactions/broadcast` | ✅ | ✅ | ❌ |
| POST | `/v1/chains/:chain/transactions/validate` | ✅ | ⚠️ | ❌ |

### Payment Requests

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/payment-requests` | ✅ | ✅ | ❌ |
| GET | `/v1/payment-requests` | ✅ | ✅ | ❌ |
| GET | `/v1/payment-requests/:paymentRequestId` | ✅ | ✅ | ❌ |
| POST | `/v1/payment-requests/:paymentRequestId/cancel` | ✅ | ✅ | ❌ |
| GET | `/v1/payment-requests/by-reference/:reference` | ✅ | ✅ | ❌ |
| GET | `/v1/payment-requests/:paymentRequestId/qr` | ✅ | ✅ | ❌ |

### Deposits

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/deposits` | ✅ | ✅ | ❌ |
| GET | `/v1/deposits/:depositId` | ✅ | ✅ | ❌ |
| GET | `/v1/chains/:chain/addresses/:address/deposits` | ✅ | ✅ | ❌ |

### Ledger

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/ledger/accounts` | ✅ | ✅ | ❌ |
| GET | `/v1/ledger/accounts` | ✅ | ✅ | ❌ |
| GET | `/v1/ledger/accounts/:ledgerAccountId` | ✅ | ✅ | ❌ |
| GET | `/v1/ledger/accounts/:ledgerAccountId/balances` | ✅ | ✅ | ❌ |
| GET | `/v1/ledger/accounts/:ledgerAccountId/entries` | ✅ | ✅ | ❌ |
| POST | `/v1/ledger/transfers` | ✅ | ✅ | ❌ |

### Sweeps

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/sweeps` | ✅ | ✅ | ❌ |
| GET | `/v1/sweeps` | ✅ | ⚠️ | ❌ |
| GET | `/v1/sweeps/:sweepId` | ✅ | ⚠️ | ❌ |

### Withdrawals

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/withdrawals` | ✅ | ⚠️ | ❌ |
| GET | `/v1/withdrawals` | ✅ | ⚠️ | ❌ |
| GET | `/v1/withdrawals/:withdrawalId` | ✅ | ⚠️ | ❌ |
| POST | `/v1/withdrawals/:withdrawalId/submit-signed` | ✅ | ⚠️ | ✅ `chainapi_submit_signed_withdrawal` |

### Webhooks

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/webhooks` | ✅ | ✅ | ❌ |
| GET | `/v1/webhooks` | ✅ | ✅ | ❌ |
| GET | `/v1/webhooks/:webhookId` | ✅ | ✅ | ❌ |
| PATCH | `/v1/webhooks/:webhookId` | ✅ | ✅ | ❌ |
| DELETE | `/v1/webhooks/:webhookId` | ✅ | ✅ | ❌ |
| POST | `/v1/webhooks/:webhookId/test` | ✅ | ✅ | ❌ |
| GET | `/v1/webhook-deliveries` | ✅ | ✅ | ❌ |
| POST | `/v1/webhook-deliveries/:deliveryId/retry` | ✅ | ✅ | ❌ |

## Zasady utrzymania dokumentacji

1. **Tabela endpointów powyżej** — aktualizuj przy każdej zmianie API (add/modify/remove endpoint).
2. **`HLD_v2.md` sekcja 6** — synchronizuj tabele endpointów z powyższą tabelą.
3. **`HLD_v2.md` sekcja 5** — aktualizuj DDL gdy zmieniasz schemat bazy.
4. **Kolekcja Postman** — aktualizuj gdy zmieniasz endpointy widoczne na zewnątrz.
5. **Testy** — nowy endpoint = nowe testy. Brak testu = jawna decyzja z komentarzem w kodzie.

## Zasady kodu

- Wszystkie zapytania SQL do tabel tenant-scoped **muszą** zawierać `WHERE tenant_id = ?`.
- Coin selection: `WHERE tenant_id = ? AND is_locked = 0 AND is_spent = 0` — nienaruszalne.
- Satoshi przechowywane jako `TEXT` w bazie (BigInt safety) — nie konwertuj na `number`.
- Klucze API przechowywane jako SHA-256 hash — raw key nigdy nie trafia do bazy.
- Sekrety webhook zwracane wyłącznie przy tworzeniu.
- Brak kluczy prywatnych — silnik ich nie przyjmuje i nie przechowuje.
