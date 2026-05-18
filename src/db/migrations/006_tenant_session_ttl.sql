-- Migration 006: per-tenant customer session token TTL
-- Allows tenants to configure how long customer session tokens are valid.
-- Default 3600 seconds (1 hour). Set to 0 to inherit global platform default.

ALTER TABLE tenant_configs
  ADD COLUMN customer_session_ttl_seconds INTEGER NOT NULL DEFAULT 3600;
