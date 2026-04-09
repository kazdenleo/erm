-- Migration: 005_create_product_skus.sql
-- Description: Создание таблицы SKU товаров в маркетплейсах

BEGIN;

CREATE TABLE IF NOT EXISTS product_skus (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    sku VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, marketplace),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_product_skus_product_id ON product_skus(product_id);
CREATE INDEX IF NOT EXISTS idx_product_skus_marketplace ON product_skus(marketplace);
CREATE INDEX IF NOT EXISTS idx_product_skus_sku ON product_skus(marketplace, sku);

COMMENT ON TABLE product_skus IS 'Таблица SKU товаров в маркетплейсах';

COMMIT;

