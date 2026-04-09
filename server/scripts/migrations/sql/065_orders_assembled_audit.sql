-- Migration: 065_orders_assembled_audit.sql
-- Когда и кем заказ отмечен собранным (склад / сборка)

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS assembled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assembled_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_assembled_at ON orders(assembled_at) WHERE assembled_at IS NOT NULL;

COMMENT ON COLUMN orders.assembled_at IS 'Дата и время отметки «Собран» в системе';
COMMENT ON COLUMN orders.assembled_by_user_id IS 'Пользователь, отметивший заказ собранным';
