-- Migration: 083_stock_movements_incoming_reserved_after.sql
-- Снимок после операции: «в пути» и «в резерве» (balance_after — по-прежнему сумма свободного остатка products.quantity).

BEGIN;

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS incoming_after INTEGER,
  ADD COLUMN IF NOT EXISTS reserved_after INTEGER;

COMMENT ON COLUMN stock_movements.balance_after IS 'Свободный остаток (сумма по складам, products.quantity) после операции';
COMMENT ON COLUMN stock_movements.incoming_after IS 'Ожидается (products.incoming_quantity) после операции';
COMMENT ON COLUMN stock_movements.reserved_after IS 'Резерв (products.reserved_quantity) после операции';

COMMIT;
