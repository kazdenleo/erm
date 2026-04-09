-- Migration: 016_create_user_categories.sql
-- Description: Создание таблицы пользовательских категорий

BEGIN;

CREATE TABLE IF NOT EXISTS user_categories (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    description TEXT,
    parent_id BIGINT REFERENCES user_categories(id) ON DELETE CASCADE,
    products_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_categories_parent_id ON user_categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_user_categories_name ON user_categories(name);

COMMENT ON TABLE user_categories IS 'Таблица пользовательских категорий товаров';
COMMENT ON COLUMN user_categories.parent_id IS 'ID родительской категории (для иерархии)';

-- Добавляем поле user_category_id в таблицу products
ALTER TABLE products ADD COLUMN IF NOT EXISTS user_category_id BIGINT REFERENCES user_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_user_category_id ON products(user_category_id);

COMMENT ON COLUMN products.user_category_id IS 'ID пользовательской категории товара';

COMMIT;

