-- Migration: 200_fbo_supply_item_collected.sql
-- Сбор этикеток FBO: счётчик «собрано» и журнал сканов для совместной работы

BEGIN;

ALTER TABLE fbo_supply_items
  ADD COLUMN IF NOT EXISTS collected_quantity INTEGER NOT NULL DEFAULT 0;

ALTER TABLE fbo_supply_items
  DROP CONSTRAINT IF EXISTS chk_fbo_supply_items_collected_nonneg;

ALTER TABLE fbo_supply_items
  ADD CONSTRAINT chk_fbo_supply_items_collected_nonneg
  CHECK (collected_quantity >= 0);

COMMENT ON COLUMN fbo_supply_items.collected_quantity IS
  'Сколько единиц собрано/промаркировано по строке (скан + печать этикетки), независимо от грузомест';

CREATE TABLE IF NOT EXISTS fbo_supply_item_scans (
  id BIGSERIAL PRIMARY KEY,
  fbo_supply_id BIGINT NOT NULL REFERENCES fbo_supplies(id) ON DELETE CASCADE,
  fbo_supply_item_id BIGINT NOT NULL REFERENCES fbo_supply_items(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  scanned_product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  barcode TEXT,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fbo_supply_item_scans_supply_id
  ON fbo_supply_item_scans (fbo_supply_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fbo_supply_item_scans_item_id
  ON fbo_supply_item_scans (fbo_supply_item_id, created_at DESC);

COMMENT ON TABLE fbo_supply_item_scans IS
  'Журнал сканов сбора этикеток FBO (мультипользовательский прогресс)';

COMMIT;
