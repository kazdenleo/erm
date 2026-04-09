-- Migration: 011_create_integrations.sql
-- Description: Создание таблицы интеграций

BEGIN;

CREATE TABLE IF NOT EXISTS integrations (
    id BIGSERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100) NOT NULL UNIQUE,
    config JSONB,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_integration_type CHECK (type IN ('marketplace', 'supplier'))
);

CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(type);
CREATE INDEX IF NOT EXISTS idx_integrations_code ON integrations(code);

COMMENT ON TABLE integrations IS 'Таблица интеграций с маркетплейсами и поставщиками';
COMMENT ON COLUMN integrations.config IS 'Конфигурация интеграции в формате JSONB';

COMMIT;

