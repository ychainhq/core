-- Migration 039: Add from_address to chain_events and deposits
--
-- from_address records the sender address for a deposit event.
--
-- Sources by asset type:
--   TRX native:  contract.parameter.value.owner_address (hex → Base58Check)
--   TRC-20:      topics[1] from the Transfer event log (indexed FROM param)
--   Bitcoin:     NULL — multiple inputs; no single sender address is practical
--
-- Populated by tron-indexer (block-scanner). btc-indexer leaves it NULL.
-- Engine propagates from chain_events → deposits via chain-event-processor-worker.

ALTER TABLE chain_events ADD COLUMN from_address TEXT;
ALTER TABLE deposits     ADD COLUMN from_address TEXT;
