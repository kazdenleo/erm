-- Участие SKU в активных рекламных кампаниях Ozon Performance.
ALTER TABLE ozon_ads_sku_stats
  ADD COLUMN IF NOT EXISTS in_active_campaign BOOLEAN,
  ADD COLUMN IF NOT EXISTS campaign_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN ozon_ads_sku_stats.in_active_campaign IS
  'true — SKU сейчас в активной кампании Performance; false — не участвует; NULL — ещё не синхронизировали членство';

COMMENT ON COLUMN ozon_ads_sku_stats.campaign_synced_at IS
  'Время последней синхронизации членства в кампаниях';

CREATE INDEX IF NOT EXISTS ozon_ads_sku_stats_active_drr_idx
  ON ozon_ads_sku_stats (scope_key, in_active_campaign, drr_percent)
  WHERE in_active_campaign IS TRUE;
