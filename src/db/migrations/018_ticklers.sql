CREATE TABLE ticklers (
  id          TEXT PRIMARY KEY,               -- 'tck_...'
  occurred_at INTEGER NOT NULL,              -- unix timestamp ms
  tenant_id   TEXT REFERENCES tenants(id),   -- NULL = tickler globalny (Platform API)
  category    TEXT NOT NULL,                 -- domena: platform, tenant, customer, wallet, ...
  subcategory TEXT NOT NULL,                 -- operacja: created, updated, status_changed, ...
  entity_id   TEXT,                          -- ID głównej encji, której dotyczy zdarzenie
  actor_login TEXT,                          -- kto wywołał: admin:<name>, key:<name>, actor:<sub>, customer:<id>, system:<worker>
  field1      TEXT,                          -- pola generyczne — semantyka zależy od (category, subcategory)
  field2      TEXT,
  field3      TEXT,
  field4      TEXT,
  field5      TEXT,
  prev_value  TEXT,                          -- JSON poprzedniego stanu encji (NULL = tworzenie)
  new_value   TEXT                           -- JSON nowego stanu encji (NULL = usunięcie)
);

CREATE INDEX idx_ticklers_tenant_id    ON ticklers(tenant_id);
CREATE INDEX idx_ticklers_occurred_at  ON ticklers(occurred_at DESC);
CREATE INDEX idx_ticklers_category     ON ticklers(category, subcategory);
CREATE INDEX idx_ticklers_entity_id    ON ticklers(entity_id);
CREATE INDEX idx_ticklers_actor_login  ON ticklers(actor_login);
