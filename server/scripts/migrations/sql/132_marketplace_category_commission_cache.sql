-- Migration: 132_marketplace_category_commission_cache.sql
-- Кэш комиссий по категориям Ozon/YM (обновление ночью или по кнопке)

BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_category_commission_cache (
    marketplace VARCHAR(20) NOT NULL,
    category_id VARCHAR(255) NOT NULL,
    schemes JSONB NOT NULL DEFAULT '[]'::jsonb,
    note TEXT,
    sample_offer_id TEXT,
    source VARCHAR(32) NOT NULL DEFAULT 'manual',
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (marketplace, category_id),
    CONSTRAINT chk_mp_comm_cache_marketplace CHECK (marketplace IN ('ozon', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_mp_comm_cache_updated
    ON marketplace_category_commission_cache (updated_at DESC);

COMMENT ON TABLE marketplace_category_commission_cache IS 'Кэш комиссий по схемам продаж для категорий Ozon/YM';
COMMENT ON COLUMN marketplace_category_commission_cache.schemes IS 'Массив { key, label, shortLabel, percent }';
COMMENT ON COLUMN marketplace_category_commission_cache.source IS 'nightly | manual | scheduler';

COMMIT;
