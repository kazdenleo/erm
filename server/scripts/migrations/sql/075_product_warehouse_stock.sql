-- Migration: 075_product_warehouse_stock.sql
-- Description: Остаток (свободный) по складам; products.quantity = сумма по складам.

BEGIN;

CREATE TABLE IF NOT EXISTS product_warehouse_stock (
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT chk_product_warehouse_stock_quantity_nonneg CHECK (quantity >= 0),
  PRIMARY KEY (product_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_product_warehouse_stock_warehouse_id
  ON product_warehouse_stock(warehouse_id);

COMMENT ON TABLE product_warehouse_stock IS 'Свободный остаток товара по складам; сумма по строкам = products.quantity';

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN stock_movements.warehouse_id IS 'Склад, к которому относится движение (если применимо)';

-- Первичное заполнение: весь текущий products.quantity на первый «свой» склад (MIN(id)), остальные склады — 0.
INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
SELECT p.id, w.id,
  CASE
    WHEN w.id = (SELECT MIN(id) FROM warehouses WHERE type = 'warehouse' AND supplier_id IS NULL)
    THEN COALESCE(p.quantity, 0)::int
    ELSE 0
  END
FROM products p
CROSS JOIN (
  SELECT id FROM warehouses WHERE type = 'warehouse' AND supplier_id IS NULL
) w
ON CONFLICT (product_id, warehouse_id) DO NOTHING;

UPDATE products p
SET
  quantity = COALESCE((
    SELECT SUM(s.quantity)::int FROM product_warehouse_stock s WHERE s.product_id = p.id
  ), 0),
  updated_at = CURRENT_TIMESTAMP;

CREATE OR REPLACE FUNCTION refresh_product_quantity_from_pws()
RETURNS TRIGGER AS $$
DECLARE
  pid BIGINT;
BEGIN
  pid := COALESCE(NEW.product_id, OLD.product_id);
  IF pid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  UPDATE products
  SET
    quantity = COALESCE((
      SELECT SUM(s.quantity)::int FROM product_warehouse_stock s WHERE s.product_id = pid
    ), 0),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = pid;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pws_refresh_product_qty ON product_warehouse_stock;
CREATE TRIGGER trg_pws_refresh_product_qty
  AFTER INSERT OR UPDATE OR DELETE ON product_warehouse_stock
  FOR EACH ROW
  EXECUTE PROCEDURE refresh_product_quantity_from_pws();

COMMIT;
