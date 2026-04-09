-- Migration: 012_create_category_mappings.sql
-- Description: Создание таблицы маппингов категорий

BEGIN;

CREATE TABLE IF NOT EXISTS category_mappings (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(50) NOT NULL,
    category_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, marketplace),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_category_mappings_product_id ON category_mappings(product_id);
CREATE INDEX IF NOT EXISTS idx_category_mappings_marketplace ON category_mappings(marketplace);

COMMENT ON TABLE category_mappings IS 'Таблица маппингов категорий товаров по маркетплейсам';

COMMIT;

