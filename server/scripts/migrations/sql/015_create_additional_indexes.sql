-- Migration: 015_create_additional_indexes.sql
-- Description: Создание дополнительных индексов для оптимизации

BEGIN;

-- Составные индексы для частых запросов
CREATE INDEX IF NOT EXISTS idx_products_brand_category ON products(brand_id, category_id);
CREATE INDEX IF NOT EXISTS idx_orders_marketplace_status ON orders(marketplace, status);
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_stock ON supplier_stocks(stock) WHERE stock > 0;
CREATE INDEX IF NOT EXISTS idx_orders_date_range ON orders(created_at) WHERE created_at IS NOT NULL;

-- Индексы для JSONB полей (GIN индексы)
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_warehouses ON supplier_stocks USING gin(warehouses);
CREATE INDEX IF NOT EXISTS idx_integrations_config ON integrations USING gin(config);
CREATE INDEX IF NOT EXISTS idx_cache_entries_value ON cache_entries USING gin(cache_value);

COMMIT;

