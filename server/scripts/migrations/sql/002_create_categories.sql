-- Migration: 002_create_categories.sql
-- Description: Создание таблицы категорий

BEGIN;

CREATE TABLE IF NOT EXISTS categories (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    marketplace VARCHAR(50) NOT NULL,
    marketplace_category_id VARCHAR(255),
    parent_id BIGINT REFERENCES categories(id) ON DELETE CASCADE,
    path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_categories_marketplace ON categories(marketplace);
CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_marketplace_id ON categories(marketplace, marketplace_category_id);

COMMENT ON TABLE categories IS 'Таблица категорий товаров по маркетплейсам';
COMMENT ON COLUMN categories.marketplace IS 'Маркетплейс: ozon, wb, ym';

COMMIT;

