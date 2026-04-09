-- Migration: 045_add_marketplace_drafts_to_products.sql
-- Description: Черновики (draft) изменений карточек маркетплейсов по товару (для последующей отправки на API)

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'ozon_draft'
  ) THEN
    ALTER TABLE products ADD COLUMN ozon_draft JSONB DEFAULT NULL;
    COMMENT ON COLUMN products.ozon_draft IS 'Черновик изменений карточки Ozon (произвольный JSON payload для отправки на API)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'wb_draft'
  ) THEN
    ALTER TABLE products ADD COLUMN wb_draft JSONB DEFAULT NULL;
    COMMENT ON COLUMN products.wb_draft IS 'Черновик изменений карточки Wildberries (произвольный JSON payload для отправки на API)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'ym_draft'
  ) THEN
    ALTER TABLE products ADD COLUMN ym_draft JSONB DEFAULT NULL;
    COMMENT ON COLUMN products.ym_draft IS 'Черновик изменений карточки Яндекс.Маркета (произвольный JSON payload для отправки на API)';
  END IF;
END $$;

COMMIT;

