-- Migration: 073_products_quantity_default_zero.sql
-- Description: Фактический складской остаток по умолчанию — 0; ранее DEFAULT 1 и подстановка при создании давали «фиктивную единицу».

BEGIN;

ALTER TABLE products
  ALTER COLUMN quantity SET DEFAULT 0;

-- Одноразово обнуляем накопленные значения (исторически многие строки получили 1 без движений по складу).
-- Если где-то реально был остаток ровно 1 шт., восстановите из резервной копии или внесите через инвентаризацию.
UPDATE products SET quantity = 0;

COMMIT;
