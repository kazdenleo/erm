-- Не передавать остатки на маркетплейсы для товаров категории (и дочерних при наследовании цепочки в коде).

ALTER TABLE user_categories
  ADD COLUMN IF NOT EXISTS skip_marketplace_stock_sync boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN user_categories.skip_marketplace_stock_sync IS
  'Если true — не отправлять остатки товаров этой категории (и потомков по parent_id) на маркетплейсы';
