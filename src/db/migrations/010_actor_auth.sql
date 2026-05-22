-- Migration 010: Actor-level authorization (X-Actor-Token RBAC)
-- Adds per-tenant actor token secret to tenant_configs.
-- Adds security envelope columns to the customers table so that
-- access-level filters (read:all / read:team / read:assigned) can be
-- applied at the data-source level without post-processing.

-- ============================================================
-- Tenant config: per-tenant HMAC secret for X-Actor-Token signing
-- ============================================================

ALTER TABLE tenant_configs ADD COLUMN actor_token_secret TEXT;

-- ============================================================
-- Customers: security envelope fields
-- ============================================================

-- User who created / owns this customer record.
-- Used for read:assigned and write:assigned filters.
ALTER TABLE customers ADD COLUMN owner_user_id TEXT;

-- Primary team of the owning user at creation time.
-- Used for read:team and write:team filters.
ALTER TABLE customers ADD COLUMN owner_team_id TEXT;

-- JSON array of additional user IDs with explicit access,
-- e.g. '["user_abc", "user_xyz"]'. NULL = no extra users.
ALTER TABLE customers ADD COLUMN access_user_ids TEXT;

-- JSON array of additional team IDs with explicit access.
-- NULL = no extra teams beyond owner_team_id hierarchy.
ALTER TABLE customers ADD COLUMN access_team_ids TEXT;

-- ============================================================
-- Indexes for access-filter queries
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_customers_owner_user
  ON customers(tenant_id, owner_user_id);

CREATE INDEX IF NOT EXISTS idx_customers_owner_team
  ON customers(tenant_id, owner_team_id);
