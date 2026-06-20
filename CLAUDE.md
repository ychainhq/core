# Chain API Engine — wskazówki dla Claude

## Stack

- **Runtime:** Node.js 20+, TypeScript
- **Framework:** Express 4
- **Baza danych (produkcja):** PostgreSQL 16+ — Docker `chainapi-postgres`, port 5433. `DATABASE_URL=postgres://chainapi:chainapi_dev@localhost:5433/chainapi`. Konfiguracja przez `DB_TYPE=postgres` w `.env`.
- **Baza danych (testy):** SQLite in-memory (`:memory:`) — używane wyłącznie w testach integracyjnych przez `bootstrapApp()`. Testy NIE dotykają Postgresa.
- **Bitcoin:** Bitcoin Core JSON-RPC (`BitcoinRpcClient`) — **stateless** (bez FWallet), brak kluczy prywatnych. Fee estimation przez `BitcoinAdapter.estimateFeeRateSatVb()`. Vsize przez `chain-adapters/bitcoin/tx-sizer.ts`. N-node broadcast przez `NodeSelector`.
- **TRON:** TRON FullNode HTTP API (`TronRpcClient`) — N-node broadcast przez `NodeSelector`. Zawsze zarejestrowany w AdapterRegistry; brak TRON_NODE_URL i brak chain_nodes → RPC calls rzucają `ApiError(503, 'TRON_NO_NODES')`.
- **Block indexer:** `packages/btc-indexer` — osobny proces skanujący bloki; engine konsumuje zdarzenia z tabeli `chain_events`
- **External signers:** provider-neutral protocol. Engine nie zalezy od OSS/Enterprise implementacji ani od Vault/AWS/Azure/GCP/HSM; zna tylko enrollment, heartbeat, signing tasks, signer responses i fingerprinty.
- **MCP:** `@modelcontextprotocol/sdk` — silnik wystawia narzędzia MCP na `/mcp/tenant`, `/mcp/customer`, `/mcp/admin`
- **Walidacja:** `zod` (body + query params)
- **Testy:** Jest + ts-jest + supertest; wszystkie testy w `tests/`
- **Build:** `tsc` → `dist/`; dev przez `ts-node`

## Kluczowe koncepty

- **FWallet** — USUNIĘTY w v3. Bitcoin Core jest teraz stateless dla engine; nie tworzymy, nie importujemy, nie odpytujemy FWalletów.
- **LWallet** — rekord portfela w bazie chain-api; role: `customer_deposits`, `tenant_hot`, `tenant_cold`, `watch_only`.
- **Tenant** — klient biznesowy platformy; izolacja przez `WHERE tenant_id = ?` we wszystkich zapytaniach SQL.
- **Customer** — końcowy użytkownik tenanta; konstrukt ledgerowy.
- **Ledger** — jedyne źródło prawdy o saldach; Bitcoin Core to infrastruktura chainowa.
- **chain_events** — tabela zdarzeń on-chain wypełniana przez indexery (btc/eth/tron). Engine NIE odpytuje chain nodes o depozyty — tylko przetwarza `chain_events`.
- **btc-indexer** — `packages/btc-indexer`. Skanuje bloki Bitcoin, pisze do `chain_events`. Zero wiedzy o tenantach.
- **eth-indexer** — `packages/eth-indexer`. Skanuje bloki EVM + logi ERC-20 Transfer.
- **tron-indexer** — `packages/tron-indexer`. Skanuje TRON przez lokalny/self-hosted FullNode/SolidityNode HTTP API; bez TronGrid i bez third-party hosted indexerów.
- **chain_nodes** — rejestr Bitcoin Core i innych node'ów. Stateless (brak FWallet). Role: `full` / `broadcast_only`.
- **engine_instances** — rejestr instancji engine'u w klastrze. Leader election via DB lease (FAZA 4).
- **ClusterService** — zarządza rejestracją i leader election. `CLUSTER_ENABLED=true` + `ENGINE_URL` + `CLUSTER_PEER_URLS` aktywuje klaster.
- **EthereumAdapter** — `chain-adapters/ethereum/adapter.ts`. Implementuje `IChainAdapter` dla Ethereum. Aktywowany gdy `ETH_NODE_URL` ustawiony.
- `tenant_id` w tabeli `cached_utxos` + `is_locked` to krytyczna granica bezpieczeństwa — coin selection nigdy nie może przekroczyć granicy tenanta.

## External signers — granica architektoniczna

- Engine publikuje i konsumuje tylko neutralny protokol external signer. Nie dodawaj w engine warunkow typu `if provider === vault/aws/azure/gcp` ani logiki zależnej od edycji signera.
- OSS signer i Enterprise signer musza zachowac zgodny kontrakt: enrollment, capabilities, fingerprint, polling, task claim, response signing, heartbeat i health semantics.
- Provider key/secret/signing/policy/audit jest wewnetrznym adapterem signera. Zmiana lub dodanie providera nie moze wymagac migracji schematu engine'u ani nowych endpointow provider-specific.
- Wspolny kod protokolu i walidacji trafia do `packages/external-signer-protocol` lub `packages/external-signer-core`; engine uzywa tych kontraktow zamiast duplikowac formaty.
- Fingerprint reprezentuje material/zakres podpisujacy, nie nazwe providera. Nie zapisuj w engine sekretow ani identyfikatorow providerow, ktore pozwalalyby ominac signer protocol.

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
| `compiler.ts` | `compileSqliteFilter()` → SQL fragment (nazwa historyczna; generuje standard SQL kompatybilny z PostgreSQL) |
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

### Sub-zasoby klienta (withdrawals, deposits per-customer)

Sub-zasoby nie mają własnego security envelope — dziedziczą dostęp od encji `customer`. Zasady:

1. Gdy endpoint przyjmuje `customerId` jako parametr (path lub query): wywołaj `customersService.getById(tenantId, customerId, accessFilter)` **przed** pobraniem sub-zasobu. Rzuca `NotFoundError` (404) gdy aktor nie ma dostępu — nie ujawniamy istnienia rekordu.
2. Dla list bez `customerId` (widok admin tenanta): wywołaj lokalną `getCustomerAccessFilter(req, 'read')` — rzuca 403 gdy aktor nie ma żadnego poziomu `customer:read`. Pełne filtrowanie po team/assigned wymaga JOIN z tabelą customers — dokumentuj jako known gap jeśli nie implementujesz.
3. **Nigdy** nie pomijaj weryfikacji klienta przy filtrowaniu po `customerId` — bez niej aktor może odczytać dane klientów spoza swojego scope uprawnień.

Wzorzec lokalnej funkcji w routerze sub-zasobu:
```typescript
function getCustomerAccessFilter(req: Request, action: 'read' | 'write'): AccessFilter {
  const ctx = req.actorContext;
  if (!ctx) return adminAllFilter(tenantId(req));
  const resolved = resolvePermission(ctx, 'customer', action);
  if (resolved.level === 'none') throw new ApiError(403, 'INSUFFICIENT_PERMISSIONS', `Actor lacks customer:${action} permission`);
  return buildAccessFilter(resolved, ctx);
}
```

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

- Każdy plik testowy woła `bootstrapApp()` z `helpers.ts` — tworzy świeżą bazę **SQLite in-memory** (`:memory:`). Testy integracyjne NIE korzystają z PostgreSQL.
- `bootstrapApp()` jest wywoływane raz per plik, nie per test (izolacja przez osobną bazę per plik)
- `uniqueAddr()` generuje unikalne adresy BTC mainnet z xpub — używaj zamiast hardcoded adresów gdy test potrzebuje unikatowego adresu
- Testy integracyjne nie mocują Bitcoin Core — komendy RPC są mocowane przez `.env.test` lub service-level stubs
- Testy jednostkowe mocują serwisy bezpośrednio (nie `getDbClient`) — zero dostępu do bazy w unit testach
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
| GET | `/admin/v1/tenants/:tenantId` | ✅ | ✅ | ✅ `chainapi_admin_get_tenant` |
| PATCH | `/admin/v1/tenants/:tenantId` | ✅ | ✅ | ✅ `chainapi_admin_update_tenant` |
| GET | `/admin/v1/tenants/:tenantId/config` | ✅ | ✅ | ✅ `chainapi_admin_get_tenant_config` |
| PATCH | `/admin/v1/tenants/:tenantId/config` | ✅ | ✅ | ✅ `chainapi_admin_update_tenant_config` |
| POST | `/admin/v1/tenants/:tenantId/api-keys` | ✅ | ✅ | ✅ `chainapi_admin_create_tenant_api_key` |
| POST | `/admin/v1/tenants/:tenantId/disable` | ✅ | ✅ | ❌ |

### Tenant self-service (`Bearer <api-key>`)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/tenant` | ✅ | ✅ | ✅ `chainapi_get_tenant` |
| PATCH | `/v1/tenant` | ✅ | ✅ | ✅ `chainapi_update_tenant` |
| GET | `/v1/tenant/config` | ✅ | ✅ | ✅ `chainapi_get_tenant_config` |
| PATCH | `/v1/tenant/config` | ✅ | ✅ | ✅ `chainapi_update_tenant_config` |

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
| GET | `/v1/me/addresses/resolve` | ✅ | ✅ | ✅ `chainapi_me_resolve_address` |
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
| GET | `/v1/chains` | ✅ | ✅ | ✅ `chainapi_list_chains` |
| GET | `/v1/chains/:chain` | ✅ | ✅ | ✅ `chainapi_get_chain` |
| GET | `/v1/assets` | ✅ | ✅ | ✅ `chainapi_list_assets` |
| GET | `/v1/chains/:chain/assets/:asset` | ✅ | ✅ | ✅ `chainapi_get_asset` |

### Wallets

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/wallets` | ✅ | ✅ | ✅ `chainapi_create_wallet` |
| GET | `/v1/wallets` | ✅ | ✅ | ✅ `chainapi_list_wallets` |
| GET | `/v1/wallets/:walletId` | ✅ | ✅ | ✅ `chainapi_get_wallet` |

### Addresses

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/chains/:chain/addresses/validate` | ✅ | ✅ | ✅ `chainapi_validate_address` |
| GET | `/v1/addresses/resolve` | ✅ | ✅ | ✅ `chainapi_resolve_address` |
| POST | `/v1/wallets/:walletId/addresses` | ✅ | ✅ | ✅ `chainapi_register_wallet_address` |
| GET | `/v1/wallets/:walletId/addresses` | ✅ | ✅ | ✅ `chainapi_list_wallet_addresses` |
| POST | `/v1/monitors/addresses` | ✅ | ✅ | ✅ `chainapi_create_monitor` |
| GET | `/v1/monitors/addresses` | ✅ | ✅ | ✅ `chainapi_list_monitors` |
| DELETE | `/v1/monitors/addresses/:monitorId` | ✅ | ⚠️ | ✅ `chainapi_deactivate_monitor` |

### Balances

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/chains/:chain/addresses/:address/balances` | ✅ | ✅ | ✅ `chainapi_get_address_balances` |
| GET | `/v1/chains/:chain/addresses/:address/balances/:asset` | ✅ | ⚠️ | ❌ |
| GET | `/v1/wallets/:walletId/balances` | ✅ | ✅ | ✅ `chainapi_get_wallet_balances` |

### UTXOs & Fees

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/chains/bitcoin/addresses/:address/utxos` | ✅ | ✅ | ✅ `chainapi_list_address_utxos` |
| GET | `/v1/wallets/:walletId/utxos` | ✅ | ✅ | ✅ `chainapi_list_wallet_utxos` |
| GET | `/v1/chains/bitcoin/fees` | ✅ | ✅ | ✅ `chainapi_get_bitcoin_fees` |
| GET | `/v1/chains/tron/fees` | ✅ | ✅ | ✅ `chainapi_get_tron_fees` |

### Transactions (Bitcoin-specific)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/chains/bitcoin/transactions/coin-selection` | ✅ | ✅ | ✅ `chainapi_bitcoin_coin_selection` |
| POST | `/v1/chains/bitcoin/transactions/prepare` | ✅ | ✅ | ✅ `chainapi_bitcoin_prepare_transaction` |
| POST | `/v1/chains/bitcoin/transactions/finalize` | ✅ | ✅ | ✅ `chainapi_bitcoin_finalize_psbt` |
| POST | `/v1/chains/bitcoin/transactions/broadcast` | ✅ | ✅ | ✅ `chainapi_broadcast_raw_transaction` |

### Transactions (generic)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/chains/:chain/transactions/:txHash` | ✅ | ⚠️ | ✅ `chainapi_get_transaction` |
| GET | `/v1/chains/:chain/transactions/:txHash/status` | ✅ | ⚠️ | ✅ `chainapi_get_transaction_status` |
| POST | `/v1/chains/:chain/transactions/broadcast` | ✅ | ✅ | ✅ `chainapi_broadcast_raw_transaction` |
| POST | `/v1/chains/:chain/transactions/validate` | ✅ | ⚠️ | ✅ `chainapi_validate_raw_transaction` |

### Payment Requests

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/payment-requests` | ✅ | ✅ | ✅ `chainapi_create_payment_request` |
| GET | `/v1/payment-requests` | ✅ | ✅ | ✅ `chainapi_list_payment_requests` |
| GET | `/v1/payment-requests/:paymentRequestId` | ✅ | ✅ | ✅ `chainapi_get_payment_request` |
| POST | `/v1/payment-requests/:paymentRequestId/cancel` | ✅ | ✅ | ✅ `chainapi_cancel_payment_request` |
| GET | `/v1/payment-requests/by-reference/:reference` | ✅ | ✅ | ✅ `chainapi_get_payment_requests_by_reference` |
| GET | `/v1/payment-requests/:paymentRequestId/qr` | ✅ | ✅ | ✅ `chainapi_get_payment_request_qr` |

### Deposits

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/deposits` | ✅ | ✅ | ✅ `chainapi_list_deposits` |
| GET | `/v1/deposits/:depositId` | ✅ | ✅ | ✅ `chainapi_get_deposit` |
| GET | `/v1/chains/:chain/addresses/:address/deposits` | ✅ | ✅ | ✅ `chainapi_list_address_deposits` |

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

> Sweepy tworzone są automatycznie przez `SweepWorker` — brak endpointu `POST /v1/sweeps`.

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/sweeps/summary` | ✅ | ✅ | ✅ `chainapi_get_sweeps_summary` |
| GET | `/v1/sweeps` | ✅ | ⚠️ | ✅ `chainapi_list_sweeps` |
| GET | `/v1/sweeps/:sweepId` | ✅ | ⚠️ | ✅ `chainapi_get_sweep` |
| POST | `/v1/sweeps/:sweepId/submit-signed` | ✅ | ⚠️ | ✅ `chainapi_submit_signed_sweep` |

### Withdrawals

> Tenant-level read endpoints. Withdrawals are created via `/v1/me/withdrawals` (customer self-service).

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/withdrawals` | ✅ | ⚠️ | ✅ `chainapi_list_withdrawals` |
| GET | `/v1/withdrawals/:withdrawalId` | ✅ | ⚠️ | ✅ `chainapi_get_withdrawal` |
| POST | `/v1/withdrawals/:withdrawalId/submit-signed` | ✅ | ⚠️ | ✅ `chainapi_submit_signed_withdrawal` |

### External Signers

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/v1/external-signers/enroll` | ✅ | ✅ | ✅ `chainapi_enroll_external_signer` |
| GET | `/v1/external-signers` | ✅ | ✅ | ✅ `chainapi_list_external_signers` |
| GET | `/v1/external-signers/policies` | ✅ | ✅ | ✅ `chainapi_get_external_signer_policies` |
| PUT | `/v1/external-signers/policies` | ✅ | ✅ | ✅ `chainapi_upsert_external_signer_policies` |
| GET | `/v1/external-signers/:signerId` | ✅ | ✅ | ✅ `chainapi_get_external_signer` |
| PATCH | `/v1/external-signers/:signerId` | ✅ | ✅ | ✅ `chainapi_update_external_signer` |
| POST | `/v1/external-signers/:signerId/enable` | ✅ | ✅ | ✅ `chainapi_enable_external_signer` |
| POST | `/v1/external-signers/:signerId/disable` | ✅ | ✅ | ✅ `chainapi_disable_external_signer` |
| DELETE | `/v1/external-signers/:signerId` | ✅ | ✅ | ✅ `chainapi_delete_external_signer` |
| POST | `/v1/external-signers/:signerId/heartbeat` | ✅ | ✅ | ✅ `chainapi_signer_heartbeat` |
| GET | `/v1/external-signers/:signerId/tasks` | ✅ | ✅ | ✅ `chainapi_list_signer_tasks` |
| POST | `/v1/external-signers/:signerId/tasks/:taskId/claim` | ✅ | ✅ | ✅ `chainapi_claim_signing_task` |
| POST | `/v1/external-signers/:signerId/tasks/:taskId/submit` | ✅ | ✅ | ✅ `chainapi_submit_signed_task` |
| POST | `/v1/external-signers/:signerId/tasks/:taskId/reject` | ✅ | ✅ | ✅ `chainapi_reject_signing_task` |

### Signing Tasks

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/signing-tasks` | ✅ | ✅ | ❌ |
| GET | `/v1/signing-tasks/:taskId` | ✅ | ✅ | ❌ |
| POST | `/v1/signing-tasks/:taskId/approve` | ✅ | ✅ | ❌ |
| POST | `/v1/signing-tasks/:taskId/reject` | ✅ | ✅ | ❌ |

### Withdrawal Batches

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/withdrawal-batches` | ✅ | ✅ | ❌ |
| GET | `/v1/withdrawal-batches/:batchId` | ✅ | ✅ | ❌ |
| POST | `/v1/withdrawal-batches/:batchId/approve` | ✅ | ✅ | ❌ |
| POST | `/v1/withdrawal-batches/:batchId/reject` | ✅ | ✅ | ❌ |
| POST | `/v1/withdrawal-batches/:batchId/retry` | ✅ | ✅ | ❌ |
| POST | `/v1/withdrawal-batches/:batchId/cancel` | ✅ | ✅ | ❌ |
| POST | `/v1/withdrawal-batches/:batchId/rbf-bump` | ✅ | ✅ | ❌ |
| POST | `/v1/withdrawal-batches/:batchId/cpfp` | ✅ | ✅ | ❌ |
| GET | `/v1/tenant/withdrawal-batch-config` | ✅ | ✅ | ✅ `chainapi_get_withdrawal_batch_config` |
| PATCH | `/v1/tenant/withdrawal-batch-config` | ✅ | ✅ | ✅ `chainapi_update_withdrawal_batch_config` |

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

### Ticklers (Audit Log)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/v1/ticklers` | ✅ | ✅ | ✅ `chainapi_list_ticklers` |
| GET | `/admin/v1/ticklers` | ✅ | ✅ | ✅ `chainapi_admin_list_ticklers` |
| GET | `/admin/v1/tenants/:tenantId/ticklers` | ✅ | ✅ | ✅ `chainapi_admin_list_tenant_ticklers` |

### Chain Nodes (v3 — multi-node infrastructure)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| POST | `/admin/v1/chain-nodes` | ✅ | ✅ | ❌ |
| GET | `/admin/v1/chain-nodes` | ✅ | ✅ | ❌ |
| GET | `/admin/v1/chain-nodes/:nodeId` | ✅ | ✅ | ❌ |
| PATCH | `/admin/v1/chain-nodes/:nodeId` | ✅ | ✅ | ❌ |
| POST | `/admin/v1/chain-nodes/:nodeId/test-connection` | ✅ | ❌ | ❌ |
| POST | `/v1/chain-nodes` | ✅ | ❌ | ❌ |
| GET | `/v1/chain-nodes` | ✅ | ✅ | ❌ |
| GET | `/v1/chain-nodes/:nodeId` | ✅ | ❌ | ❌ |
| PATCH | `/v1/chain-nodes/:nodeId` | ✅ | ❌ | ❌ |
| DELETE | `/v1/chain-nodes/:nodeId` | ✅ | ❌ | ❌ |
| POST | `/v1/chain-nodes/:nodeId/set-primary` | ✅ | ❌ | ❌ |
| POST | `/v1/chain-nodes/:nodeId/test-connection` | ✅ | ❌ | ❌ |

### Engine Cluster HA (FAZA 4)

| Method | Path | MVP | Testy | MCP |
|--------|------|-----|-------|-----|
| GET | `/admin/v1/cluster/status` | ✅ | ❌ | ❌ |
| POST | `/internal/cluster/heartbeat` | ✅ | ❌ | ❌ |
| POST | `/internal/cluster/claim-leadership` | ✅ | ❌ | ❌ |

## Zasady utrzymania dokumentacji

1. **Tabela endpointów powyżej** — aktualizuj przy każdej zmianie API (add/modify/remove endpoint).
2. **`HLD_v2.md` sekcja 6** — synchronizuj tabele endpointów z powyższą tabelą.
3. **`HLD_v2.md` sekcja 5** — aktualizuj DDL gdy zmieniasz schemat bazy.
4. **Kolekcja Postman** — aktualizuj gdy zmieniasz endpointy widoczne na zewnątrz.
5. **Testy** — nowy endpoint = nowe testy. Brak testu = jawna decyzja z komentarzem w kodzie.

## Zasady kodu

### Zakaz magic numbers

Literały liczbowe w kodzie są dozwolone tylko gdy ich znaczenie jest oczywiste z kontekstu (np. `0`, `1`, indeksy tablicowe). Każda inna liczba musi być nazwaną stałą. Zasada wyboru gdzie mieszka ta stała:

| Typ stałej | Gdzie mieszka |
|-----------|---------------|
| Protokołowa / chain-specific (rozmiary, progi) | `const` w pliku chain-adaptera lub `tx-sizer.ts` |
| Konfiguracja deployment (timeouty, retry, porty) | `config/index.ts` jako zmienna środowiskowa z sensownym default |
| Polityka biznesowa per-tenant (fee targets, progi, limity) | kolumna w `tenant_configs` lub `tenant_withdrawal_batch_configs` — nie hardkoduj |
| Stała używana w jednym pliku, nie reużywalna | `const` na poziomie modułu w tym pliku |
| Stała używana w wielu plikach | export z dedykowanego pliku stałych |

Przykłady **zakazane**: `let fallback = 5`, `targetBlocks: 6`, `const OVERHEAD = 10`, `output > 546`.
Przykłady **dozwolone**: `const FALLBACK_FEE_RATE_SAT_VB = 5`, `config.btc_fee_target_blocks`, `P2WPKH_INPUT_VBYTES` z tx-sizer, `DUST_THRESHOLD_SATS = 546n`.

- Wszystkie zapytania SQL do tabel tenant-scoped **muszą** zawierać `WHERE tenant_id = ?`.
- Coin selection: `WHERE tenant_id = ? AND is_locked = 0 AND is_spent = 0` — nienaruszalne.
- Satoshi przechowywane jako `TEXT` w bazie (BigInt safety) — nie konwertuj na `number`.
- Klucze API przechowywane jako SHA-256 hash — raw key nigdy nie trafia do bazy.
- Sekrety webhook zwracane wyłącznie przy tworzeniu.
- Brak kluczy prywatnych — silnik ich nie przyjmuje i nie przechowuje.
- **Każda mutacja danych musi wywołać `ticklerService.record()`** — ticklery są immutable audit logiem umożliwiającym pełną rekonstrukcję historii. Brak ticklera = niekompletny audit trail.
- Tabela `ticklers` jest write-once: nigdy nie modyfikuj ani nie usuwaj wierszy. Tylko INSERT.
- Workers używają `actorLogin: 'system:{worker-name}'`; router-level endpointy używają `resolveActorLogin(req)`.
- Tickler call ZAWSZE po udanej mutacji (nie przed), aby entity_id był znany.
- **`deposits.upsert()` zwraca `{ deposit, isNew, previousStatus }`** — używaj tych flag zamiast dodatkowych SELECT do określenia czy depozyt jest nowy i jaki był poprzedni status.
- **Statusy depozytu to wyłącznie `detected` i `confirmed`** — nie używaj `pending_confirmation` ani `finalized` w nowym kodzie.

### N-node dynamic adapter selection (BTC + TRON)

- **`NodeSelector`** (`chain-adapters/node-selector.ts`) — jedyny punkt dostępu do listy nodów. Odpytuje `chainNodesService.getHealthyNodes(chainId)` przy każdym wywołaniu RPC z TTL cache 10s. Gdy DB nie ma wpisów dla danego chain → fallback na `BITCOIN_RPC_URL` / `TRON_NODE_URL` z env. Gdy ani DB, ani env → pusta lista → `ApiError(503)`.
- **`BitcoinRpcClient`** i **`TronRpcClient`** przyjmują `NodeSelector` w konstruktorze — nie czytają bezpośrednio z `config`. Konstruktory adapterów (`BitcoinAdapter`, `TronAdapter`) też przyjmują `NodeSelector`.
- **Failover BTC:** connection error / HTTP non-200 / JSON parse error → next node. Bitcoin Core RPC błąd (właściwa odpowiedź JSON z `error`) → propaguj natychmiast, nie failoveruj.
- **Failover TRON:** fetch throw / HTTP non-2xx → next node. TRON protocol error (`result: false` w JSON 200) → propaguj natychmiast (nie jest błędem nodea).
- **`TRON adapter zawsze zarejestrowany`** — nie jest już warunkowy na `TRON_NODE_URL`. Jeśli nie ma nodów, RPC calls rzucają `TRON_NO_NODES`. Pozwala to na podpinanie nodów TRON przez `chain_nodes` API bez restartu.
- **Per-node retry:** każdy node ma własne `max_attempts` i `retry_delay_ms` z `chain_nodes`. Retry przed failoverem do następnego nodea.
- **Credentials per node:** `rpc_password_ref = 'env:VAR_NAME'` rozwiązywane inline w `NodeSelector` przy każdym cyklu cache — bez dodatkowego DB round-trip.

### Architektura kluczy TRON

TRON ma trzy odrębne klucze o różnych rolach — ważne żeby nie mylić ich zakresów:

| Klucz | Rola | Gdzie żyje | Dev env var | Engine widzi? |
|-------|------|-----------|-------------|---------------|
| SR key (`localwitness`) | Podpisywanie bloków na poziomie protokołu TRON | `config-node1.conf` w nodzie TRON | — | Nigdy |
| Withdrawal key | Hot wallet: wypłaty klientów, bezpośredni klucz `m/1/0` | External signer, fingerprint `TRON_SIGNER_FINGERPRINT` | `TRON_DEV_PRIVATE_KEY_HEX` (w signerze) | Nigdy |
| Sweep HD xprv | Klucze sweep per-depozyt: BIP32 `m/0/N`, SLIP44 coin 195 | External signer, fingerprint `TRON_SIGNER_FINGERPRINT_HD` | `TRON_DEV_ACCOUNT_XPRV` (w signerze) | Nigdy |

**Dev provisioning (seed.ts):** `runSeed()` generuje account xprv (`m/44'/195'/0'`) → zapisuje `tron_xpub` do `tenant_configs` → wyprowadza `m/1/0` (hot wallet node) → zapisuje `TRON_DEV_PRIV_KEY_HEX` i `TRON_DEV_HOT_ADDRESS` do `engine/.env` → wywołuje `upsertTronTreasuryWallet(tenantId, hotAddress)` → tworzy `tenant_hot` wallet z adresem TRON + ledger accounts (sweep_in_transit, network_fee_expense). `start.sh` następnie przekazuje te wartości do konfiguracji signera.

**SR key / localwitness** — genesis dev key (`da146374a75310b9666e834ee4ad0866d6f4035967bfc76217c5a495fff9f0d5`), skonfigurowany tylko w `config-node1.conf` TRON noda. Dotyczy produkcji bloków przez Super Representative. Engine nigdy nie widzi, nie przechowuje ani nie przekazuje tego klucza.

#### Drzewo BIP32 i podział ról

Z jednego seeda (`m/44'/195'/0'` = account node) wynikają wszystkie adresy:

```
account xprv  m/44'/195'/0'
├── m/0/0  ← adres depozytowy klienta 0   ┐
├── m/0/1  ← adres depozytowy klienta 1   ├─ TRON_SIGNER_FINGERPRINT_HD (sweep HD xprv)
├── m/0/N  ← adres depozytowy klienta N   ┘
│
└── m/1/0  ← adres hot wallet tenanta     ── TRON_SIGNER_FINGERPRINT (withdrawal key)
```

- `m/0/*` — external chain, adresy depozytowe klientów. Signer HD derivuje child key per zadanie sweep.
- `m/1/0` — internal chain, pierwszy adres = hot wallet. Jeden stały klucz, używany do wszystkich wypłat.

Signer ma **dwa oddzielne wpisy** bo zakresy dostępu do klucza muszą być rozdzielone: HD xprv może derivować dowolny klucz depozytowy, ale nie powinien podpisywać wypłat; withdrawal key ma dostęp tylko do `m/1/0` i nie dotyka ścieżki `m/0/*`.

#### Depozyty TRON/USDT

```
POST /v1/customers/:id/deposit-address { chain: 'tron' }
  → engine czyta tron_xpub z tenant_configs
  → bip32.fromBase58(xpub).derive(0).derive(N) → publicKey
  → tronAddressFromPublicKey(publicKey) → "TXxx..."  (keccak256 + Base58Check)
  → INSERT INTO addresses (wallet_role=customer_deposits, metadata.derivationPath="m/0/N")
  → INSERT INTO watched_addresses → tron-indexer obserwuje adres

Klient wysyła USDT on-chain:
  → tron-indexer wykrywa transakcję → INSERT INTO chain_events
  → deposit-event-processor.worker: fetchUnprocessed → INSERT INTO deposits (status='detected')
  → po N potwierdzeń (tron_confirmations_required) → status='confirmed'
```

Engine operuje wyłącznie na kluczach publicznych — adresy derivowane z `tron_xpub`, nigdy z xprv.

#### Sweepy TRON/USDT

Cel: przelać USDT z adresów depozytowych (`m/0/N`) do hot wallet (`m/1/0`), skąd idą wypłaty.

```
TronSweepWorker (co 60s):
  → dla każdego tenanta z tron_sweep_threshold_sun: sprawdza USDT balance każdego adresu depozytowego
  → balance >= threshold? → buduje sweep:
      from: adres klienta "TXxx..." (m/0/N)
      to:   tenant_hot address      (m/1/0)
  → POST /wallet/triggersmartcontract na TRON FullNode
      ← { txID, raw_data, raw_data_hex }
  → INSERT INTO sweeps (status='pending_signature')
  → INSERT INTO signing_tasks:
        requestType: 'tron_sweep'
        payloadFormat: 'tron_raw_tx'
        unsignedPayload: { derivationPath: "m/0/N", txID, raw_data_hex, ... }
        signerId → signer z TRON_SIGNER_FINGERPRINT_HD

Signer HD odbiera task:
  → derivuje m/0/N z HD xprv → child private key
  → signRecoverable(txID_bytes, childKey) → 65-bajtowy podpis
  → POST /v1/external-signers/:id/tasks/:taskId/submit
  → engine broadcastuje przez TRON FullNode → txHash
  → sweeps.status → 'broadcast' → 'confirmed'
```

`derivationPath` jest częścią `unsignedPayload` — signer sam derivuje właściwy klucz. Jeden HD xprv obsługuje nieograniczoną liczbę adresów depozytowych.

Sweepy idą do `tenant_hot` (nie `tenant_cold`) — analogicznie jak w BTC. `tenant_cold` nie istnieje dla TRON w obecnej architekturze. Wypłaty wychodzą z `tenant_hot`, więc środki muszą tam trafić.

#### Wypłaty TRON/USDT

```
POST /v1/me/withdrawals { assetId: 'tron:USDT', amount, toAddress }
  → INSERT INTO customer_withdrawals

WithdrawalBatcher (cyklicznie):
  → odpytuje wallet_role='tenant_hot', chain_id='tron' → adres hot wallet (m/1/0)
  → buduje unsigned TRC-20 transfer:
      from: hot wallet address (m/1/0)
      to:   adres klienta (zewnętrzny)
  → POST /wallet/triggersmartcontract → { txID, raw_data_hex }
  → INSERT INTO withdrawal_batches + signing_tasks:
        requestType: 'tron_withdrawal'
        payloadFormat: 'tron_raw_tx'
        signerId → signer z TRON_SIGNER_FINGERPRINT

Signer (withdrawal key) odbiera task:
  → używa bezpośredniego klucza m/1/0 (bez HD derivacji)
  → signRecoverable(txID_bytes, hotKey) → podpis
  → engine broadcastuje
```

#### Przepływ środków

```
Klient USDT   ──deposit──►  m/0/N  (customer_deposits wallet)
                                       │
                               sweep  (signer HD, TRON_SIGNER_FINGERPRINT_HD)
                               derivuje m/0/N → podpisuje
                                       │
                                       ▼
              m/1/0  (tenant_hot wallet)  ◄── TRX na gas (zasilany ręcznie przez tenanta)
                                       │
                            withdrawal (signer, TRON_SIGNER_FINGERPRINT)
                            używa m/1/0 wprost → podpisuje
                                       │
                                       ▼
                            Zewnętrzny adres klienta
```

**TRX na gas:** TRON pobiera bandwidth/energy za każdy transfer TRC-20. Tenant musi utrzymywać TRX na adresie `m/1/0` (hot wallet, do sweepów wychodzących i withdrawali) oraz na każdym adresie depozytowym przed sweepem. `tronFeeService.estimateFee()` szacuje koszt przed każdą operacją; signer weryfikuje że `feeLimitSun` nie przekracza skonfigurowanego maksimum.

**Jak budowane jest `raw_data` transakcji TRON:**
Engine nie buduje `raw_data` ręcznie. Engine wywołuje `POST /wallet/triggersmartcontract` na lokalnym TRON FullNode, który zwraca:
```json
{ "txID": "<sha256 of raw_data>", "raw_data": {...}, "raw_data_hex": "..." }
```
To TRON FullNode jest autorytatywny w kwestii formatu i zawartości `raw_data`. Engine bierze `txID` i `raw_data_hex` i przekazuje je jako `unsignedPayload` do external signera przez signer protocol.

**Co signer podpisuje:** `txID` (sha256 raw_data) → `signRecoverable(txIdBytes, privKey)` → 65 bajtów (64B podpis + 1B recovery ID) → 130 hex chars. TRON wymaga tego formatu EC recoverable signature dla weryfikacji na chain.

**Warstwy weryfikacji w signerze (3):**
1. `assertTronTxTaskValid` — allowlist sieci i kontraktów, limity kwoty/fee, poprawność ścieżki derywacji
2. `sha256(unsignedPayload) === unsignedPayloadHash` — integralność payloadu (signer recalculates)
3. `txIdBytes.length === 32` — format txID

**Reguły:**
- Engine nie przyjmuje i nie przechowuje żadnego z powyższych kluczy.
- `rpc_password_ref` w chain_nodes dla nodów TRON: format `env:VAR_NAME` — kredencjale nigdy plaintext w DB.
- TRON node credentials (jeśli HTTP API wymaga auth) — `rpc_user` + `rpc_password_ref` jak dla BTC nodów.

### Enkapsulacja fee estimation (Bitcoin)

- **`BitcoinAdapter.estimateFeeRateSatVb()`** — jedyny publiczny punkt dostępu do fee rate w sat/vbyte. Wywołuj zamiast bezpośredniego `adapter.estimateSmartFee()`. Zawiera: TTL cache (30s, konfigurowalny przez `BTC_FEE_RATE_CACHE_TTL_MS`), fallback `FALLBACK_FEE_RATE_SAT_VB=5` gdy Bitcoin Core niedostępny, opcjonalne clampy `maxSatVb`/`minSatVb` dla polityki per-tenant.
- **`estimateTxVsize()` z `chain-adapters/bitcoin/tx-sizer.ts`** — jedyne źródło prawdy o rozmiarze BTC transakcji. Nie duplikuj wzorów `10 + 68*n + 31*m` ani `42 + 68*n` w nowym kodzie. Eksportuje per-type rozmiary outputów (`P2WPKH=31`, `P2TR=43`, `P2PKH=34`, `P2SH=32`, `P2WSH=43`) i stałą wejściową `P2WPKH_INPUT_VBYTES=68`.
- **`tenant_configs.btc_fee_target_blocks`** — per-tenant target bloków dla sweepów i operacji bez własnej konfiguracji (domyślnie 6). Batcher ma własną politykę w `tenant_withdrawal_batch_configs.btc_target_blocks`.

### Zasady v3 — chain_events i btc-indexer

- **Engine NIE wywołuje `listunspent`, `importaddress`, `importdescriptors`, `createwallet`, `loadwallet`** w kontekście detekcji depozytów. Te operacje są domeną `btc-indexer`.
- **Engine NIE wywołuje `walletcreatefundedpsbt`** w ścieżce withdrawal. Withdrawal batcher, RBF i CPFP używają `createpsbt` + `utxoupdatepsbt` — stateless, bez named wallet. Istniejące wywołania `walletcreatefundedpsbt` w `bitcoin-transactions.service.ts` i `prepare.router.ts` są legacy — objęte FAZA 2 cleanup.
- **`ChainEventProcessorWorker`** pobiera eventy przez `chainEventsService.fetchUnprocessed()` i oznacza je przez `chainEventsService.markProcessed()`. Zero bezpośredniego SQL na `chain_events` w workerze.



- **Dwa statusy depozytu:** `detected` i `confirmed`. Brak `pending_confirmation` i `finalized`. Próg N pochodzi z `tenant_configs.btc_confirmations_required` (per-tenant), czytany przez `tenantsService.getConfirmationsRequired()`.
- **Transition gate depozytów:** tickler `detected` emitowany raz — przy `isNew=true` (INSERT depozytu). Tickler `confirmed` raz — przy `previousStatus !== 'confirmed' && status === 'confirmed'`. Re-processing już potwierdzonego depozytu = operacja bezoperacyjna (zero ticklerów, zero efektów).
- **chain_node credentials**: `rpc_password_ref` w formacie `'env:VAR_NAME'` → engine czyta z `process.env` przy connect. Nigdy nie loguj ani nie zwracaj w API.
- **`pg_notify`** po rejestracji nowego adresu: `SELECT pg_notify('btc_address_registered', address)` — powiadamia btc-indexer o nowych adresach w czasie rzeczywistym. W testach (SQLite) brak tej funkcji — indexer robi pełny reload co 60s.
- `chain_events.processed = FALSE` + UNIQUE partial index gwarantuje exactly-once processing nawet gdy wiele indexerów raportuje ten sam tx. Indexer resetuje `processed=0` tylko gdy confirmations rosną I są poniżej `INDEXER_FINALITY_CONFIRMATIONS`.

### Enkapsulacja SQL — właścicielstwo tabel

Każdy serwis jest **jedynym właścicielem** swoich tabel. SQL (INSERT/UPDATE/DELETE) na danej tabeli może się znajdować tylko w serwisie-właścicielu.

| Serwis-właściciel | Tabele |
|-------------------|--------|
| `withdrawals.service` | `customer_withdrawals` |
| `withdrawal-batcher.service` | `withdrawal_batches`, `withdrawal_batch_items`, `tenant_withdrawal_batch_configs` |
| `signing-tasks.service` | `signing_tasks`, `signer_signature_audit` |
| `utxo-lock.service` (shared) | `utxo_locks`, `cached_utxos` |
| `deposits.service` | `deposits` |
| `ledger.service` | `ledger_accounts`, `ledger_entries` |
| `addresses.service` | `addresses` |
| `monitors.service` | `watched_addresses` |
| `customers.service` | `customers` |
| `wallets.service` | `wallets` |
| `transactions.service` | `transactions` |
| `webhooks.service` | `webhooks`, `webhook_deliveries` |
| `external-signers.service` | `external_signers`, `external_signer_policies` |
| `sweeps.service` | `sweeps` |
| `payment-requests.service` | `payment_requests` |
| `tenants.service` | `tenants`, `tenant_configs` |
| `tickler.service` | `ticklers` |
| `idempotency.service` | `idempotency_keys` |
| `chain-nodes.service` (v3) | `chain_nodes`, `tenant_chain_bindings` |
| `chain-events.service` (v3) | `chain_events` — tylko UPDATE processed=TRUE; INSERT należy do indexerów |
| `cluster.service` (FAZA 4) | `engine_instances` |

**Reguły:**
- Jeśli serwis A potrzebuje zmutować dane należące do serwisu B → wywołaj metodę serwisu B, nie pisz SQL bezpośrednio.
- Operacje INSERT na danej tabeli mogą być tylko w jednym serwisie. Nigdy nie twórz rekordu z zewnętrznego serwisu.
- Shared services (`utxo-lock`, `tickler`, `idempotency`) są wyjątkiem — są zaprojektowane do współdzielenia, ale nadal mają wyłączne właścicielstwo swoich tabel.
- Naruszenie tej zasady = circular dependency lub god-service — oba są sygnałem złej architektury.

**`utxo_locks` — tabela polimorficzna (migracja 032):**
- Kolumna `reference_id` (dawniej `batch_id`) + `reference_type` ('batch' | 'sweep') — jeden rekord może należeć do withdrawal batch LUB do sweep.
- Metody dla batchy: `lockUtxosForBatch`, `releaseLocksForBatch`, `markSpentForBatch`, `getLockedForBatch`, `lockSingleUtxo`, `reassignLocks`.
- Metody dla sweepów: `lockUtxosForSweep`, `releaseLocksForSweep`, `markSpentForSweep`.
- TTL: batch = 15 min (`UTXO_LOCK_TTL_SECONDS`), sweep = 7 dni (`SWEEP_UTXO_LOCK_TTL_SECONDS`) — safety net, nie normalny lifecycle.
- Sweep lock lifecycle: `locked` po create sweep → `released` gdy sweep `failed` → `spent` gdy sweep `confirmed` (btc-indexer ustawia `is_spent=1` niezależnie).
