-- Migration: 115_warehouse_weekend_days.sql
-- Description: Выходные дни склада для планирования закупок у поставщиков

BEGIN;

ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS weekend_days SMALLINT[] DEFAULT NULL;

COMMENT ON COLUMN warehouses.weekend_days IS
    'Выходные дни склада (0=вс … 6=сб, Europe/Moscow). Заказы после cutoff группируются до следующего рабочего дня.';

COMMIT;
