-- Migration: 007_create_suppliers.sql
-- Description: Создание таблицы поставщиков

BEGIN;

CREATE TABLE IF NOT EXISTS suppliers (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    code VARCHAR(100) NOT NULL UNIQUE,
    api_config JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_suppliers_code ON suppliers(code);
CREATE INDEX IF NOT EXISTS idx_suppliers_is_active ON suppliers(is_active);

COMMENT ON TABLE suppliers IS 'Таблица поставщиков';
COMMENT ON COLUMN suppliers.code IS 'Уникальный код поставщика (mikado, moskvorechie)';
COMMENT ON COLUMN suppliers.api_config IS 'Конфигурация API в формате JSONB';

COMMIT;

