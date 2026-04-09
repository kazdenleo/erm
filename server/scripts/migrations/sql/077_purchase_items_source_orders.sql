-- Migration: 077_purchase_items_source_orders.sql
-- Привязка строки закупки к заказам ERM (для возврата в «Новый» при удалении из черновика)

BEGIN;

ALTER TABLE purchase_items
  ADD COLUMN IF NOT EXISTS source_orders JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN purchase_items.source_orders IS 'Заказы из «В закупку»: [{ marketplace, orderId }] — при удалении строки статус in_procurement → new';

COMMIT;
