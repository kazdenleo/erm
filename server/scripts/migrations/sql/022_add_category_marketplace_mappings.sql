-- Migration: 022_add_category_marketplace_mappings.sql
-- Description: Добавление поля для хранения сопоставлений категорий маркетплейсов на уровне категории

BEGIN;

-- Добавляем поле для хранения сопоставлений маркетплейсов в формате JSON
ALTER TABLE user_categories ADD COLUMN IF NOT EXISTS marketplace_mappings JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_user_categories_marketplace_mappings ON user_categories USING GIN (marketplace_mappings);

COMMENT ON COLUMN user_categories.marketplace_mappings IS 'Сопоставления категорий маркетплейсов в формате JSON: {"wb": "123", "ozon": "456", "ym": "789"}';

COMMIT;
