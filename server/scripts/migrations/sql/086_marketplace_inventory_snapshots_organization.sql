-- Привязка снапшотов остатков маркетплейсов к организации (контекст X-Organization-Id).

ALTER TABLE marketplace_inventory_snapshots
  ADD COLUMN IF NOT EXISTS organization_id BIGINT NULL;

CREATE INDEX IF NOT EXISTS marketplace_inventory_snapshots_org_created_idx
  ON marketplace_inventory_snapshots (organization_id, created_at DESC);

