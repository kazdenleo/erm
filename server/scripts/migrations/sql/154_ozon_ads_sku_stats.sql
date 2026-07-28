-- Migration: 154_ozon_ads_sku_stats.sql
-- Description: ДРР / расход рекламы Ozon Performance по offer_id (SKU) для расчёта мин. цены

BEGIN;

CREATE TABLE IF NOT EXISTS ozon_ads_sku_stats (
  id BIGSERIAL PRIMARY KEY,
  scope_key TEXT NOT NULL DEFAULT '',
  profile_id INTEGER,
  organization_id INTEGER,
  offer_id TEXT NOT NULL,
  spend NUMERIC(14, 2) NOT NULL DEFAULT 0,
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  drr_percent NUMERIC(8, 4),
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  source TEXT NOT NULL DEFAULT 'performance_api',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ozon_ads_sku_stats_scope_offer_uidx UNIQUE (scope_key, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_ozon_ads_sku_stats_offer
  ON ozon_ads_sku_stats (offer_id);

CREATE INDEX IF NOT EXISTS idx_ozon_ads_sku_stats_updated
  ON ozon_ads_sku_stats (updated_at DESC);

COMMENT ON TABLE ozon_ads_sku_stats IS
  'Агрегированная статистика рекламы Ozon Performance по offer_id для включения ДРР в мин. цену';

COMMIT;
