-- Migration: 078_add_purchase_price_to_purchase_items.sql
-- Description: Добавить закупочную цену в строки закупки (purchase_items.purchase_price)

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchase_items' AND column_name = 'purchase_price'
    ) THEN
        ALTER TABLE purchase_items ADD COLUMN purchase_price DECIMAL(10, 2) DEFAULT NULL;
        ALTER TABLE purchase_items ADD CONSTRAINT chk_purchase_price CHECK (purchase_price IS NULL OR purchase_price >= 0);
        COMMENT ON COLUMN purchase_items.purchase_price IS 'Закупочная цена по строке закупки (может отличаться от products.cost)';
    END IF;
END $$;

COMMIT;

