-- Расширение price_push_settings: исключения товаров и градации мин. наценки.
-- Формат JSON (profiles.price_push_settings):
-- {
--   scope, categoryIds, productIds, pushFbs, pushFbo,
--   excludeProductIds: number[],
--   minMarkupRules: [{ id, enabled, name, scope, categoryIds, productIds, excludeProductIds,
--     tiers: [{ costFrom, costTo, mode: 'rub'|'percent', value }] }]
-- }

COMMENT ON COLUMN profiles.price_push_settings IS
  'Отправка цен на МП + градации наценки: { scope, categoryIds, productIds, excludeProductIds, pushFbs, pushFbo, minMarkupRules[] }. Организации — organizations.auto_push_marketplace_prices.';
