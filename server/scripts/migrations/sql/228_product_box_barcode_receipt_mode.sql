-- Migration: 228_product_box_barcode_receipt_mode.sql
-- Description: ШК коробки и шт. в упаковке у товара; режим приёмки (сканер/ручная) в профиле

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS box_barcode VARCHAR(255),
  ADD COLUMN IF NOT EXISTS units_per_box INTEGER;

COMMENT ON COLUMN products.box_barcode IS 'Штрихкод коробки/упаковки: при скане в приёмке добавляется units_per_box шт.';
COMMENT ON COLUMN products.units_per_box IS 'Количество штук в одной коробке (по box_barcode)';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_units_per_box_positive'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_units_per_box_positive
      CHECK (units_per_box IS NULL OR units_per_box > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_box_barcode_unique
  ON products (box_barcode)
  WHERE box_barcode IS NOT NULL AND TRIM(box_barcode) <> '';

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS purchase_receipt_mode VARCHAR(16) NOT NULL DEFAULT 'scanner';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_purchase_receipt_mode_check'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_purchase_receipt_mode_check
      CHECK (purchase_receipt_mode IN ('scanner', 'manual'));
  END IF;
END $$;

COMMENT ON COLUMN profiles.purchase_receipt_mode IS
  'Режим приёмки: scanner — только сканирование (+ удаление сканом); manual — ручной ввод количества';

COMMIT;
