-- Ручная корректировка наличия на складе в списке остатков
BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS allow_manual_warehouse_stock_edit BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.allow_manual_warehouse_stock_edit IS
  'Разрешить ручное изменение наличия на складе в списке остатков (иначе только документы)';

COMMIT;
