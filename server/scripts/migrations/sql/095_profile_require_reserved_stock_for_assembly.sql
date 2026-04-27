-- Добавить тумблер: требовать фактический резерв для «На сборку».
-- Если true: заказ нельзя отправить на сборку, пока под него не создан резерв и он покрыт фактическим остатком.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS require_reserved_stock_for_assembly boolean NOT NULL DEFAULT false;

