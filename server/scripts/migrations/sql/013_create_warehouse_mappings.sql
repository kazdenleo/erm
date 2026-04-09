-- Migration: 013_create_warehouse_mappings.sql
-- Description: Создание таблицы маппингов складов

BEGIN;

CREATE TABLE IF NOT EXISTS warehouse_mappings (
    id BIGSERIAL PRIMARY KEY,
    warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    marketplace_warehouse_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(warehouse_id, marketplace),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_warehouse_mappings_warehouse_id ON warehouse_mappings(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_mappings_marketplace ON warehouse_mappings(marketplace);

COMMENT ON TABLE warehouse_mappings IS 'Таблица маппингов складов по маркетплейсам';

COMMIT;

