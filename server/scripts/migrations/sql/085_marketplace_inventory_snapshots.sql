-- Ежедневные снапшоты остатков на складах маркетплейсов и "в пути" (к клиенту / возвраты).
-- Используется для расчёта суммы себестоимостей по состояниям.

CREATE TABLE IF NOT EXISTS marketplace_inventory_snapshots (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NULL,
  marketplace TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NULL,
  notes TEXT NULL
);

CREATE INDEX IF NOT EXISTS marketplace_inventory_snapshots_profile_created_idx
  ON marketplace_inventory_snapshots (profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_inventory_snapshots_market_created_idx
  ON marketplace_inventory_snapshots (marketplace, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_inventory_snapshot_lines (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES marketplace_inventory_snapshots(id) ON DELETE CASCADE,
  state TEXT NOT NULL, -- mp_warehouse | to_customer | returning
  external_sku TEXT NOT NULL,
  warehouse_name TEXT NULL,
  quantity INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS marketplace_inventory_snapshot_lines_snapshot_idx
  ON marketplace_inventory_snapshot_lines (snapshot_id);

CREATE INDEX IF NOT EXISTS marketplace_inventory_snapshot_lines_sku_idx
  ON marketplace_inventory_snapshot_lines (external_sku);

