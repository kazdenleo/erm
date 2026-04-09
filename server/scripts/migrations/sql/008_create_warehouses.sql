-- Migration: 008_create_warehouses.sql
-- Description: Создание таблицы складов

BEGIN;

CREATE TABLE IF NOT EXISTS warehouses (
    id BIGSERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    address TEXT,
    supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    main_warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_warehouse_type CHECK (type IN ('warehouse', 'supplier'))
);

CREATE INDEX IF NOT EXISTS idx_warehouses_type ON warehouses(type);
CREATE INDEX IF NOT EXISTS idx_warehouses_supplier_id ON warehouses(supplier_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_main_warehouse_id ON warehouses(main_warehouse_id);

COMMENT ON TABLE warehouses IS 'Таблица складов';
COMMENT ON COLUMN warehouses.type IS 'Тип склада: warehouse или supplier';

COMMIT;

