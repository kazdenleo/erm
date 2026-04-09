-- Migration: 009_create_supplier_stocks.sql
-- Description: Создание таблицы остатков поставщиков

BEGIN;

CREATE TABLE IF NOT EXISTS supplier_stocks (
    id BIGSERIAL PRIMARY KEY,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    stock INTEGER NOT NULL DEFAULT 0,
    price DECIMAL(10, 2),
    delivery_days INTEGER DEFAULT 0,
    stock_name VARCHAR(255),
    source VARCHAR(50) DEFAULT 'api',
    warehouses JSONB,
    cached_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(supplier_id, product_id),
    CONSTRAINT chk_stock CHECK (stock >= 0),
    CONSTRAINT chk_delivery_days CHECK (delivery_days >= 0),
    CONSTRAINT chk_source CHECK (source IN ('api', 'cache'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_stocks_supplier_id ON supplier_stocks(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_product_id ON supplier_stocks(product_id);
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_sku ON supplier_stocks(supplier_id, product_id);
CREATE INDEX IF NOT EXISTS idx_supplier_stocks_cached_at ON supplier_stocks(cached_at);

COMMENT ON TABLE supplier_stocks IS 'Таблица остатков товаров у поставщиков';
COMMENT ON COLUMN supplier_stocks.warehouses IS 'JSONB массив складов с остатками';
COMMENT ON COLUMN supplier_stocks.source IS 'Источник данных: api или cache';

COMMIT;

