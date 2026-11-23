-- Человекочитаемый номер заказа WB FBO (gNumber из Statistics /supplier/orders).
-- order_id по-прежнему хранит srid — уникальный ключ отгрузки.
ALTER TABLE marketplace_fbo_orders
  ADD COLUMN IF NOT EXISTS g_number VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_marketplace_fbo_orders_g_number
  ON marketplace_fbo_orders (profile_id, marketplace, g_number)
  WHERE g_number IS NOT NULL AND TRIM(g_number) <> '';
