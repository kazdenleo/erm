-- Migration: 028_allow_manual_marketplace_in_orders.sql
-- Description: Разрешить marketplace = 'manual' для ручных заказов

BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_marketplace;
ALTER TABLE orders ADD CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym', 'manual'));

COMMIT;
