-- Ежедневный импорт карточек товаров с маркетплейсов (Ozon, WB, Яндекс.Маркет).
-- По умолчанию выключено: без явного включения карточки не тянем по расписанию.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS daily_pull_marketplace_cards boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.daily_pull_marketplace_cards IS
  'Если true — раз в сутки импортировать карточки товаров организации с маркетплейсов; при изменениях — уведомление';
