-- Migration 007: Move chain-type-specific fields into specs JSON
-- Replaces scalar chain_id (EVM chain ID) and finality_type with a single
-- extensible specs JSON column. This keeps the chains table clean — only
-- universal fields stay top-level; type-specific config lives in specs.
--
-- BTC  specs: {"finality_type":"confirmations"}
-- ETH  specs: {"finality_type":"safe_finalized","evm_chain_id":1}

ALTER TABLE chains ADD COLUMN specs TEXT;

UPDATE chains SET specs =
  CASE
    WHEN chain_id IS NOT NULL
      THEN json_object('finality_type', finality_type, 'evm_chain_id', chain_id)
    ELSE
      json_object('finality_type', finality_type)
  END;

ALTER TABLE chains DROP COLUMN finality_type;
ALTER TABLE chains DROP COLUMN chain_id;
