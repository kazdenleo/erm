-- Migration: 018_add_order_acceptance_time_to_warehouses.sql
-- Description: Добавление поля времени приема заказов для складов поставщиков

BEGIN;

-- Добавляем поле времени приема заказов (формат TIME)
ALTER TABLE warehouses 
ADD COLUMN IF NOT EXISTS order_acceptance_time TIME;

-- Добавляем комментарий к полю
COMMENT ON COLUMN warehouses.order_acceptance_time IS 'Время приема заказов для склада поставщика (формат HH:MM)';

-- Создаем индекс для быстрого поиска по времени приема заказов
CREATE INDEX IF NOT EXISTS idx_warehouses_order_acceptance_time 
ON warehouses(order_acceptance_time) 
WHERE order_acceptance_time IS NOT NULL;

COMMIT;

