-- Migration 008: Move asset-type-specific fields into specs JSON
-- Replaces scalar contract_address with a single extensible specs JSON column.
-- decimals stays top-level — it is universal across all asset types.
--
-- native assets (BTC, ETH):  specs = null
-- token assets (USDC, etc.): specs = {"contract_address":"0x..."}

ALTER TABLE assets ADD COLUMN specs TEXT;

UPDATE assets SET specs = json_object('contract_address', contract_address)
  WHERE contract_address IS NOT NULL;

ALTER TABLE assets DROP COLUMN contract_address;
