-- Migration: 227_purchase_cargo_places.sql
-- Грузоместа закупки: сначала принимаем места по штрихкоду поставщика/ТК,
-- затем вскрываем каждое и принимаем товар из него в приёмку по закупке.

BEGIN;

ALTER TABLE purchases ADD COLUMN IF NOT EXISTS expected_cargo_places INTEGER;
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS chk_purchases_expected_cargo_places;
ALTER TABLE purchases ADD CONSTRAINT chk_purchases_expected_cargo_places
  CHECK (expected_cargo_places IS NULL OR expected_cargo_places >= 0);

COMMENT ON COLUMN purchases.expected_cargo_places IS 'Ожидаемое число грузомест (по накладной/от ТК), NULL — неизвестно';

CREATE TABLE IF NOT EXISTS purchase_cargo_places (
  id BIGSERIAL PRIMARY KEY,
  purchase_id BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  barcode VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'accepted',
  receipt_id BIGINT REFERENCES purchase_receipts(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  opened_at TIMESTAMPTZ,
  opened_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  closed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_purchase_cargo_places_barcode UNIQUE (purchase_id, barcode),
  CONSTRAINT chk_purchase_cargo_places_status CHECK (status IN ('accepted', 'opened', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_purchase_cargo_places_barcode ON purchase_cargo_places(barcode);
CREATE INDEX IF NOT EXISTS idx_purchase_cargo_places_receipt ON purchase_cargo_places(receipt_id);

COMMENT ON TABLE purchase_cargo_places IS 'Грузоместа закупки: accepted — принято, opened — вскрыто (идёт приёмка товара), closed — товар принят';
COMMENT ON COLUMN purchase_cargo_places.receipt_id IS 'Приёмка по закупке, в которую попадает товар из грузоместа';

CREATE TABLE IF NOT EXISTS purchase_cargo_place_items (
  cargo_place_id BIGINT NOT NULL REFERENCES purchase_cargo_places(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cargo_place_id, product_id),
  CONSTRAINT chk_purchase_cargo_place_items_qty CHECK (quantity > 0)
);

COMMENT ON TABLE purchase_cargo_place_items IS 'Товар, принятый из грузоместа; входит в purchase_receipt_items приёмки грузоместа';

COMMIT;
