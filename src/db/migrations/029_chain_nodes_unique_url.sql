-- Migration 029: Deduplicate chain_nodes and add unique index on (chain_id, rpc_url, tenant_id)
--
-- Problem: start.sh called POST /admin/v1/chain-nodes on every run without checking
-- for existing nodes. Each restart created duplicate entries with the same rpc_url.
--
-- Fix: keep the oldest record per (chain_id, rpc_url, COALESCE(tenant_id,'')) and
-- add a unique index to prevent future duplicates at the DB level.

-- 1. Delete duplicate chain_nodes — keep the oldest (MIN id = first created)
DELETE FROM chain_nodes
WHERE id NOT IN (
  SELECT MIN(id)
  FROM chain_nodes
  GROUP BY chain_id, rpc_url, COALESCE(tenant_id, '')
);

-- 2. Unique index — COALESCE(tenant_id,'') so that two NULL tenant_ids conflict
CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_nodes_url
  ON chain_nodes(chain_id, rpc_url, COALESCE(tenant_id, ''));
