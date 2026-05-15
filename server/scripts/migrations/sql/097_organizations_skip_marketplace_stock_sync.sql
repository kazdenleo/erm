-- Не передавать остатки склада на маркетплейсы (Ozon, WB, Яндекс.Маркет).

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS skip_marketplace_stock_sync boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.skip_marketplace_stock_sync IS
  'Если true — не отправлять остатки со склада организации на маркетплейсы';
