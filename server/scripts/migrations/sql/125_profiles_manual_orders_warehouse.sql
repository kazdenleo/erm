-- Migration: 125_profiles_manual_orders_warehouse.sql
-- Description: Склад списания остатков для ручных заказов (настройка профиля)

BEGIN;

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS manual_orders_warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN profiles.manual_orders_warehouse_id IS 'Склад резерва/списания для заказов marketplace=manual (при allow_private_orders)';

-- Перенос из флага склада (миграция 124), если уже был задан
UPDATE profiles p
SET manual_orders_warehouse_id = w.id
FROM warehouses w
WHERE w.profile_id = p.id
  AND w.is_manual_orders_warehouse = TRUE
  AND w.type = 'warehouse'
  AND p.manual_orders_warehouse_id IS NULL;

COMMIT;
