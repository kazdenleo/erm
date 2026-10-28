-- Migration: 241_ads_module.sql
-- Description: Единый модуль рекламы Ozon / WB / YM (кампании, статистика, аудит, автоматизация)

BEGIN;

CREATE TABLE IF NOT EXISTS ads_campaigns (
  id BIGSERIAL PRIMARY KEY,
  scope_key TEXT NOT NULL DEFAULT '',
  profile_id INTEGER,
  organization_id INTEGER,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('ozon', 'wildberries', 'yandex')),
  external_id TEXT NOT NULL,
  name TEXT,
  status TEXT,
  campaign_type TEXT,
  daily_budget NUMERIC(14, 2),
  bid NUMERIC(14, 4),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ads_campaigns_scope_mp_ext_uidx UNIQUE (scope_key, marketplace, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_campaigns_profile_mp
  ON ads_campaigns (profile_id, marketplace);

CREATE INDEX IF NOT EXISTS idx_ads_campaigns_status
  ON ads_campaigns (marketplace, status);

CREATE TABLE IF NOT EXISTS ads_campaign_products (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES ads_campaigns(id) ON DELETE CASCADE,
  sku_key TEXT NOT NULL,
  external_product_id TEXT,
  bid NUMERIC(14, 4),
  status TEXT,
  in_active BOOLEAN,
  spend NUMERIC(14, 2) NOT NULL DEFAULT 0,
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  drr_percent NUMERIC(8, 4),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ads_campaign_products_camp_sku_uidx UNIQUE (campaign_id, sku_key)
);

CREATE INDEX IF NOT EXISTS idx_ads_campaign_products_sku
  ON ads_campaign_products (sku_key);

CREATE TABLE IF NOT EXISTS ads_sku_stats (
  id BIGSERIAL PRIMARY KEY,
  scope_key TEXT NOT NULL DEFAULT '',
  profile_id INTEGER,
  organization_id INTEGER,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('ozon', 'wildberries', 'yandex')),
  sku_key TEXT NOT NULL,
  spend NUMERIC(14, 2) NOT NULL DEFAULT 0,
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  views BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  orders BIGINT NOT NULL DEFAULT 0,
  drr_percent NUMERIC(8, 4),
  in_active_campaign BOOLEAN,
  period_from DATE,
  period_to DATE,
  campaign_synced_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'api',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ads_sku_stats_scope_mp_sku_uidx UNIQUE (scope_key, marketplace, sku_key)
);

CREATE INDEX IF NOT EXISTS idx_ads_sku_stats_mp_sku
  ON ads_sku_stats (marketplace, sku_key);

CREATE INDEX IF NOT EXISTS idx_ads_sku_stats_profile_drr
  ON ads_sku_stats (profile_id, marketplace, drr_percent DESC NULLS LAST)
  WHERE in_active_campaign IS TRUE;

CREATE TABLE IF NOT EXISTS ads_sku_stats_daily (
  id BIGSERIAL PRIMARY KEY,
  scope_key TEXT NOT NULL DEFAULT '',
  profile_id INTEGER,
  organization_id INTEGER,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('ozon', 'wildberries', 'yandex')),
  sku_key TEXT NOT NULL,
  stat_date DATE NOT NULL,
  spend NUMERIC(14, 2) NOT NULL DEFAULT 0,
  revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  views BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  orders BIGINT NOT NULL DEFAULT 0,
  drr_percent NUMERIC(8, 4),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ads_sku_stats_daily_uidx UNIQUE (scope_key, marketplace, sku_key, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_ads_sku_stats_daily_range
  ON ads_sku_stats_daily (profile_id, marketplace, stat_date);

CREATE TABLE IF NOT EXISTS ads_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  scope_key TEXT NOT NULL DEFAULT '',
  profile_id INTEGER,
  organization_id INTEGER,
  marketplace TEXT,
  kind TEXT NOT NULL DEFAULT 'stats',
  status TEXT NOT NULL DEFAULT 'running',
  days INTEGER,
  message TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ads_sync_runs_started
  ON ads_sync_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS ads_action_log (
  id BIGSERIAL PRIMARY KEY,
  scope_key TEXT NOT NULL DEFAULT '',
  profile_id INTEGER,
  organization_id INTEGER,
  marketplace TEXT NOT NULL,
  campaign_id BIGINT REFERENCES ads_campaigns(id) ON DELETE SET NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  ok BOOLEAN NOT NULL DEFAULT false,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ads_action_log_created
  ON ads_action_log (created_at DESC);

CREATE TABLE IF NOT EXISTS ads_automation_rules (
  id BIGSERIAL PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  organization_id INTEGER,
  marketplace TEXT CHECK (marketplace IS NULL OR marketplace IN ('ozon', 'wildberries', 'yandex')),
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('zero_stock_pause', 'target_drr_bid')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ads_automation_rules_profile
  ON ads_automation_rules (profile_id, enabled);

CREATE TABLE IF NOT EXISTS ads_automation_runs (
  id BIGSERIAL PRIMARY KEY,
  rule_id BIGINT REFERENCES ads_automation_rules(id) ON DELETE SET NULL,
  profile_id INTEGER,
  marketplace TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  actions_count INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ads_automation_runs_created
  ON ads_automation_runs (created_at DESC);

COMMENT ON TABLE ads_campaigns IS 'Рекламные кампании Ozon / WB / YM';
COMMENT ON TABLE ads_sku_stats IS 'Агрегированный ДРР по SKU для мин. цены и дашборда';
COMMENT ON TABLE ads_sku_stats_daily IS 'Дневная статистика рекламы по SKU';
COMMENT ON TABLE ads_automation_rules IS 'Правила автопаузы и биддера';

COMMIT;
