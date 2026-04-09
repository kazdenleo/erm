-- Migration: 020_create_wb_commissions.sql
-- Description: Создание таблицы для хранения комиссий Wildberries

BEGIN;

CREATE TABLE IF NOT EXISTS wb_commissions (
    id BIGSERIAL PRIMARY KEY,
    category_id INTEGER NOT NULL,
    category_name VARCHAR(500),
    commission_percent DECIMAL(5, 2) NOT NULL,
    min_price DECIMAL(10, 2),
    max_price DECIMAL(10, 2),
    delivery_percent DECIMAL(5, 2),
    return_percent DECIMAL(5, 2),
    raw_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category_id)
);

CREATE INDEX IF NOT EXISTS idx_wb_commissions_category_id ON wb_commissions(category_id);
CREATE INDEX IF NOT EXISTS idx_wb_commissions_updated_at ON wb_commissions(updated_at);

COMMENT ON TABLE wb_commissions IS 'Таблица комиссий Wildberries по категориям';
COMMENT ON COLUMN wb_commissions.category_id IS 'ID категории WB';
COMMENT ON COLUMN wb_commissions.category_name IS 'Название категории WB';
COMMENT ON COLUMN wb_commissions.commission_percent IS 'Процент комиссии WB';
COMMENT ON COLUMN wb_commissions.min_price IS 'Минимальная цена для применения комиссии';
COMMENT ON COLUMN wb_commissions.max_price IS 'Максимальная цена для применения комиссии';
COMMENT ON COLUMN wb_commissions.delivery_percent IS 'Процент доставки';
COMMENT ON COLUMN wb_commissions.return_percent IS 'Процент возврата';
COMMENT ON COLUMN wb_commissions.raw_data IS 'Полные данные из API WB в формате JSON';

-- Триггер для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_wb_commissions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_wb_commissions_updated_at
    BEFORE UPDATE ON wb_commissions
    FOR EACH ROW
    EXECUTE FUNCTION update_wb_commissions_updated_at();

COMMIT;

