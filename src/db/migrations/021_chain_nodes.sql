-- Migration 021: Chain nodes registry (v3 multi-node architecture)
--
-- Registers Bitcoin Core (and future ETH/TRON) nodes used by the engine.
--
-- KEY v3 PRINCIPLE: All Bitcoin Core nodes are STATELESS from the engine's perspective.
-- The engine has no FWallet, never calls importaddress/listunspent.
-- ALL operations (PSBT build, broadcast, fee estimation, tx lookup) work on ANY synced node.
-- The concepts of "primary" and "standby" DO NOT EXIST in v3.
--
-- chain_nodes.role — the ONLY meaningful distinction between nodes:
--   'full'           — full node with complete UTXO index and tx index (-txindex=1)
--                      Can handle: PSBT ops (createpsbt, utxoupdatepsbt), fee estimation,
--                      tx lookup (getrawtransaction), broadcast (sendrawtransaction)
--   'broadcast_only' — pruned node (no full UTXO index); suitable ONLY for sendrawtransaction
--                      and basic chain info. Cannot do PSBT construction.
--
-- chain_nodes.priority — routing preference (lower = preferred):
--   When multiple healthy nodes exist, engine uses the one with lowest priority value.
--   Tenant can override via tenant_chain_bindings (e.g. compliance, latency).
--
-- chain_nodes.rpc_password_ref — NEVER store plaintext:
--   Platform nodes: 'env:VAR_NAME' → engine reads process.env['VAR_NAME']
--   Tenant-owned nodes: AES-256 encrypted value
--
-- tenant_chain_bindings.preferred_node_id — routing preference only:
--   Not a "primary wallet" (no wallet concept in v3).
--   Used for: compliance (EU-only node), latency (geographically close node),
--   custom infrastructure (tenant's own node).

CREATE TABLE IF NOT EXISTS chain_nodes (
  id                  TEXT PRIMARY KEY,          -- 'node_...' (nanoid)
  chain_id            TEXT NOT NULL REFERENCES chains(id),
  tenant_id           TEXT REFERENCES tenants(id), -- NULL = platform-wide node
  label               TEXT NOT NULL,             -- 'btc-primary', 'btc-standby-eu'
  rpc_url             TEXT NOT NULL,             -- 'http://10.0.1.10:8332'
  rpc_user            TEXT NOT NULL,
  rpc_password_ref    TEXT NOT NULL,             -- 'env:VAR_NAME' — never plaintext
  network             TEXT NOT NULL DEFAULT 'mainnet', -- 'mainnet' | 'testnet' | 'regtest'
  role                TEXT NOT NULL DEFAULT 'full',    -- 'full' | 'broadcast_only'
  priority            INTEGER NOT NULL DEFAULT 100,    -- lower = higher preference
  timeout_ms          INTEGER NOT NULL DEFAULT 10000,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  retry_delay_ms      INTEGER NOT NULL DEFAULT 1000,
  is_enabled          INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'unknown', -- 'healthy' | 'degraded' | 'unreachable' | 'unknown'
  block_height        INTEGER,
  last_checked_at     TEXT,
  last_healthy_at     TEXT,
  last_error          TEXT,
  metadata            TEXT,                      -- JSON: { region, datacenter, version }
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chain_nodes_chain_role
  ON chain_nodes(chain_id, role, is_enabled);

CREATE INDEX IF NOT EXISTS idx_chain_nodes_tenant
  ON chain_nodes(tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chain_nodes_priority
  ON chain_nodes(chain_id, priority)
  WHERE is_enabled = 1;

-- Per-tenant preferred node binding.
-- If a tenant has no binding, the engine uses the lowest-priority enabled platform node.
-- Optional: most tenants will use the platform default.

CREATE TABLE IF NOT EXISTS tenant_chain_bindings (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  chain_id          TEXT NOT NULL REFERENCES chains(id),
  preferred_node_id TEXT NOT NULL REFERENCES chain_nodes(id),
  fallback_node_id  TEXT REFERENCES chain_nodes(id),
  override_reason   TEXT,  -- e.g. 'compliance_eu_only', 'dedicated_node'
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(tenant_id, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_tcb_tenant_chain ON tenant_chain_bindings(tenant_id, chain_id);
CREATE INDEX IF NOT EXISTS idx_tcb_node         ON tenant_chain_bindings(preferred_node_id);
