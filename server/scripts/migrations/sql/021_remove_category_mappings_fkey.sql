-- Migration: 021_remove_category_mappings_fkey.sql
-- Description: Удаление внешнего ключа category_id из category_mappings, так как для WB категории хранятся в wb_commissions

BEGIN;

-- Удаляем внешний ключ, так как для разных маркетплейсов категории хранятся в разных таблицах
-- WB: wb_commissions, Ozon/YM: categories
ALTER TABLE category_mappings 
  DROP CONSTRAINT IF EXISTS category_mappings_category_id_fkey;

COMMENT ON COLUMN category_mappings.category_id IS 'ID категории. Для WB - из wb_commissions.category_id, для Ozon/YM - из categories.id';

COMMIT;
