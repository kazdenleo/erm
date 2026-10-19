-- Migration: 233_product_box_packagings.sql
-- Description: Несколько упаковок (ШК + шт. в коробке) на один товар

BEGIN;

CREATE TABLE IF NOT EXISTS product_box_packagings (
  id BIGSERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode VARCHAR(255) NOT NULL,
  units_per_box INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT product_box_packagings_units_positive CHECK (units_per_box > 0),
  CONSTRAINT product_box_packagings_barcode_nonempty CHECK (TRIM(barcode) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_box_packagings_barcode_unique
  ON product_box_packagings (LOWER(TRIM(barcode)));

CREATE INDEX IF NOT EXISTS idx_product_box_packagings_product_id
  ON product_box_packagings (product_id, sort_order, id);

COMMENT ON TABLE product_box_packagings IS
  'Упаковки товара: при скане barcode в приёмке добавляется units_per_box шт.';

-- Перенос существующей одиночной упаковки
INSERT INTO product_box_packagings (product_id, barcode, units_per_box, sort_order)
SELECT p.id, TRIM(p.box_barcode), p.units_per_box, 0
  FROM products p
 WHERE NULLIF(TRIM(COALESCE(p.box_barcode, '')), '') IS NOT NULL
   AND p.units_per_box IS NOT NULL
   AND p.units_per_box > 0
   AND NOT EXISTS (
     SELECT 1 FROM product_box_packagings b
      WHERE LOWER(TRIM(b.barcode)) = LOWER(TRIM(p.box_barcode))
   );

COMMIT;
