-- Migration: 048_add_additional_expenses_to_products.sql
-- Дополнительные расходы (рядом с себестоимостью в карточке товара)

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'additional_expenses'
    ) THEN
        ALTER TABLE products ADD COLUMN additional_expenses DECIMAL(14, 2) DEFAULT NULL;
        ALTER TABLE products ADD CONSTRAINT chk_additional_expenses CHECK (additional_expenses IS NULL OR additional_expenses >= 0);
        COMMENT ON COLUMN products.additional_expenses IS 'Дополнительные расходы (не себестоимость)';
    END IF;
END $$;

COMMIT;
