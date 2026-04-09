-- Migration: 021_add_wb_warehouse_name_to_warehouses.sql
-- Description: Добавление поля для склада Wildberries в таблицу warehouses

BEGIN;

ALTER TABLE warehouses 
ADD COLUMN IF NOT EXISTS wb_warehouse_name VARCHAR(255);

COMMENT ON COLUMN warehouses.wb_warehouse_name IS 'Название склада Wildberries из тарифов';

COMMIT;

