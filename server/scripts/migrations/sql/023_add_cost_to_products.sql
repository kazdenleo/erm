-- Migration: 023_add_cost_to_products.sql
-- Description: Добавление поля cost (себестоимость) в таблицу products

BEGIN;

-- Добавляем поле cost, если его еще нет
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'products' AND column_name = 'cost'
    ) THEN
        ALTER TABLE products ADD COLUMN cost DECIMAL(10, 2) DEFAULT NULL;
        ALTER TABLE products ADD CONSTRAINT chk_cost CHECK (cost >= 0);
        COMMENT ON COLUMN products.cost IS 'Себестоимость товара (обновляется автоматически при синхронизации с поставщиками)';
    END IF;
END $$;

COMMIT;
