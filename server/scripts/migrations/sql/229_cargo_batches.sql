-- Migration: 229_cargo_batches.sql
-- Приёмка грузомест без закупки: сначала места, затем товар из каждого места.
-- После оформления создаётся warehouse_receipt; разбивка по местам сохраняется.

BEGIN;

CREATE TABLE IF NOT EXISTS cargo_batches (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
  expected_places INTEGER,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  warehouse_receipt_id BIGINT REFERENCES warehouse_receipts(id) ON DELETE SET NULL,
  note TEXT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_cargo_batches_status CHECK (status IN ('open', 'completed', 'cancelled')),
  CONSTRAINT chk_cargo_batches_expected CHECK (expected_places IS NULL OR expected_places >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cargo_batches_profile_status ON cargo_batches(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_cargo_batches_warehouse ON cargo_batches(warehouse_id);

COMMENT ON TABLE cargo_batches IS 'Пакет приёмки грузомест без закупки';

CREATE TABLE IF NOT EXISTS cargo_places (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES cargo_batches(id) ON DELETE CASCADE,
  barcode VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'accepted',
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  opened_at TIMESTAMPTZ,
  opened_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  closed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_cargo_places_batch_barcode UNIQUE (batch_id, barcode),
  CONSTRAINT chk_cargo_places_status CHECK (status IN ('accepted', 'opened', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_cargo_places_barcode ON cargo_places(barcode);
CREATE INDEX IF NOT EXISTS idx_cargo_places_batch ON cargo_places(batch_id);

COMMENT ON TABLE cargo_places IS 'Грузоместа пакета: accepted — принято, opened — в работе, closed — разобрано';

CREATE TABLE IF NOT EXISTS cargo_place_items (
  cargo_place_id BIGINT NOT NULL REFERENCES cargo_places(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cargo_place_id, product_id),
  CONSTRAINT chk_cargo_place_items_qty CHECK (quantity > 0)
);

COMMENT ON TABLE cargo_place_items IS 'Товар, принятый из грузоместа без закупки';

COMMIT;
