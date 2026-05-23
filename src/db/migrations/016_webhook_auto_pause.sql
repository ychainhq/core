-- Migration 016: Webhook auto-pause support
-- Tracks consecutive permanent failures per webhook so the worker can
-- automatically deactivate webhooks that are consistently unreachable.

ALTER TABLE webhooks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhooks ADD COLUMN auto_paused_at TEXT;
