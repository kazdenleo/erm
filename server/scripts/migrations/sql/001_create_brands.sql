-- Migration: 001_create_brands.sql
-- Description: Создание таблицы брендов

BEGIN;

CREATE TABLE IF NOT EXISTS brands (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name);

COMMENT ON TABLE brands IS 'Таблица брендов товаров';
COMMENT ON COLUMN brands.id IS 'Уникальный идентификатор бренда';
COMMENT ON COLUMN brands.name IS 'Название бренда (уникальное)';

COMMIT;

