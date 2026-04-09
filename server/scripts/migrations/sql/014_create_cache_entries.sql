-- Migration: 014_create_cache_entries.sql
-- Description: Создание таблицы кэша

BEGIN;

CREATE TABLE IF NOT EXISTS cache_entries (
    id BIGSERIAL PRIMARY KEY,
    cache_type VARCHAR(100) NOT NULL,
    cache_key VARCHAR(500) NOT NULL,
    cache_value JSONB NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cache_type, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_cache_entries_type ON cache_entries(cache_type);
CREATE INDEX IF NOT EXISTS idx_cache_entries_key ON cache_entries(cache_type, cache_key);
CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at ON cache_entries(expires_at);

COMMENT ON TABLE cache_entries IS 'Таблица кэша для различных типов данных';
COMMENT ON COLUMN cache_entries.cache_type IS 'Тип кэша: wb_categories, wb_commissions, wb_warehouses и т.д.';

COMMIT;

