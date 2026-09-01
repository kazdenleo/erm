-- Настройки области отправки цен на маркетплейсы (по аккаунту / profile).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS price_push_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.price_push_settings IS
  'Отправка цен на МП: { scope: all|categories|products, categoryIds: [], productIds: [] }. Организации — organizations.auto_push_marketplace_prices.';
