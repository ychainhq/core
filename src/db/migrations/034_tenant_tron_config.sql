-- Migration 034: Add TRON chain config columns to tenant_configs
--
-- tron_xpub                  — account-level BIP32 xpub for HD deposit address derivation
--                              (m/44'/195'/0' — SLIP44 coin type 195 for TRON)
-- tron_next_derivation_index — atomic counter for the next child index (m/0/{index})
-- tron_confirmations_required— per-tenant required confirmations before a TRON deposit is 'confirmed'
-- tron_sweep_threshold_sun   — minimum USDT balance (in sun, 6 decimals) to trigger a sweep;
--                              NULL disables sweep for this tenant

ALTER TABLE tenant_configs ADD COLUMN tron_xpub TEXT DEFAULT NULL;
ALTER TABLE tenant_configs ADD COLUMN tron_next_derivation_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenant_configs ADD COLUMN tron_confirmations_required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tenant_configs ADD COLUMN tron_sweep_threshold_sun TEXT DEFAULT NULL;
