-- Кэш «калькулятора» маркетплейсов (комиссии, логистика и т.д.) для массового пересчёта без запроса к API на каждый SKU.
-- Обновление: по кнопке/cron (sync-calculator-cache), либо пополняется после успешного live-расчёта.

BEGIN;

CREATE TABLE IF NOT EXISTS product_mp_calculator_cache (
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(20) NOT NULL,
    calculator JSONB NOT NULL,
    source VARCHAR(32) DEFAULT 'api',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (product_id, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_mp_calc_cache_m_updated
    ON product_mp_calculator_cache (marketplace, updated_at DESC);

COMMENT ON TABLE product_mp_calculator_cache IS 'Снимок данных калькулятора мин. цены (Ozon/WB/YM) для офлайн-пересчёта';
COMMENT ON COLUMN product_mp_calculator_cache.source IS 'api | batch_v5 | live_single и т.п.';

COMMIT;
