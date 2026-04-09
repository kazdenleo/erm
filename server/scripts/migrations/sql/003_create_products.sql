-- Migration: 003_create_products.sql
-- Description: Создание таблицы товаров

BEGIN;

CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY,
    sku VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(1000) NOT NULL,
    brand_id BIGINT REFERENCES brands(id) ON DELETE SET NULL,
    category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    price DECIMAL(10, 2) NOT NULL DEFAULT 0,
    min_price DECIMAL(10, 2) DEFAULT 0,
    buyout_rate INTEGER DEFAULT 100,
    weight INTEGER,
    length INTEGER,
    width INTEGER,
    height INTEGER,
    volume DECIMAL(10, 3),
    quantity INTEGER DEFAULT 1,
    unit VARCHAR(50) DEFAULT 'шт',
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_price CHECK (price >= 0),
    CONSTRAINT chk_min_price CHECK (min_price >= 0),
    CONSTRAINT chk_buyout_rate CHECK (buyout_rate >= 0 AND buyout_rate <= 100)
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);

-- Full-text search index для поиска по названию
CREATE INDEX IF NOT EXISTS idx_products_name_fts ON products USING gin(to_tsvector('russian', name));

COMMENT ON TABLE products IS 'Таблица товаров';
COMMENT ON COLUMN products.sku IS 'Артикул товара (уникальный)';
COMMENT ON COLUMN products.weight IS 'Вес в граммах';
COMMENT ON COLUMN products.length IS 'Длина в мм';
COMMENT ON COLUMN products.width IS 'Ширина в мм';
COMMENT ON COLUMN products.height IS 'Высота в мм';
COMMENT ON COLUMN products.volume IS 'Объем в литрах';

COMMIT;

