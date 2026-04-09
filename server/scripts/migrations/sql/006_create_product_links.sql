-- Migration: 006_create_product_links.sql
-- Description: Создание таблицы связей товаров с маркетплейсами

BEGIN;

CREATE TABLE IF NOT EXISTS product_links (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    is_linked BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, marketplace),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_product_links_product_id ON product_links(product_id);
CREATE INDEX IF NOT EXISTS idx_product_links_marketplace ON product_links(marketplace);

COMMENT ON TABLE product_links IS 'Таблица связей товаров с маркетплейсами';

COMMIT;

