-- Автоматическая отправка цен на маркетплейсы (Ozon, WB, Яндекс.Маркет).
-- По умолчанию выключено: без явного включения цены на МП не меняем.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_push_marketplace_prices boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.auto_push_marketplace_prices IS
  'Если true — разрешена автоматическая отправка/корректировка цен на маркетплейсы для товаров этой организации';
