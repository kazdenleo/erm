-- Название склада (для UI); адрес остаётся отдельным полем.
BEGIN;

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS name TEXT;

UPDATE warehouses
SET name = LEFT(TRIM(address), 200)
WHERE (name IS NULL OR TRIM(name) = '')
  AND address IS NOT NULL
  AND TRIM(address) <> '';

COMMENT ON COLUMN warehouses.name IS 'Краткое название склада для списков и заказов';

COMMIT;
