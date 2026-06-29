-- Migration: 136_wb_fbo_forecast.sql
-- Снапшоты остатков WB FBO (склад × размер) для прогнозирования поставок

BEGIN;

CREATE TABLE IF NOT EXISTS wb_fbo_forecast_snapshots (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NULL,
  organization_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  row_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NULL
);

CREATE INDEX IF NOT EXISTS wb_fbo_forecast_snapshots_profile_created_idx
  ON wb_fbo_forecast_snapshots (profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wb_fbo_forecast_snapshots_org_created_idx
  ON wb_fbo_forecast_snapshots (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wb_fbo_forecast_rows (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES wb_fbo_forecast_snapshots(id) ON DELETE CASCADE,
  nm_id BIGINT NULL,
  chrt_id BIGINT NULL,
  warehouse_id BIGINT NULL,
  warehouse_name TEXT NULL,
  region_name TEXT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  in_way_to_client INTEGER NOT NULL DEFAULT 0,
  in_way_from_client INTEGER NOT NULL DEFAULT 0,
  external_sku TEXT NOT NULL,
  wb_vendor_code TEXT NULL,
  product_id BIGINT NULL REFERENCES products(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS wb_fbo_forecast_rows_snapshot_idx
  ON wb_fbo_forecast_rows (snapshot_id);

CREATE INDEX IF NOT EXISTS wb_fbo_forecast_rows_product_idx
  ON wb_fbo_forecast_rows (product_id);

CREATE INDEX IF NOT EXISTS wb_fbo_forecast_rows_wh_idx
  ON wb_fbo_forecast_rows (warehouse_id);

COMMENT ON TABLE wb_fbo_forecast_snapshots IS 'Снимки остатков WB FBO для раздела «Прогнозирование поставок»';
COMMENT ON TABLE wb_fbo_forecast_rows IS 'Строка = размер товара на складе WB (данные stocks-report/wb-warehouses)';

COMMIT;
