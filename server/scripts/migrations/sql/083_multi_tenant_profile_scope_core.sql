-- Migration: 083_multi_tenant_profile_scope_core.sql
-- Description: Core multi-tenant scoping by profile_id (products, orders, suppliers, warehouses, stock_movements)

BEGIN;

-- 1) Helper: pick "main" profile_id for existing data (greentaxi account)
DO $$
DECLARE
  pid BIGINT;
BEGIN
  SELECT u.profile_id INTO pid
  FROM users u
  WHERE LOWER(TRIM(u.email)) = LOWER(TRIM('greentaxi@list.ru'))
  ORDER BY u.id ASC
  LIMIT 1;

  IF pid IS NULL THEN
    SELECT p.id INTO pid FROM profiles p ORDER BY p.id ASC LIMIT 1;
  END IF;

  -- PRODUCTS
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL;
  UPDATE products SET profile_id = pid WHERE profile_id IS NULL;
  ALTER TABLE products ALTER COLUMN profile_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_products_profile_id ON products(profile_id);

  -- Orders: add profile_id and move uniqueness to (profile_id, marketplace, order_id)
  ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL;
  UPDATE orders SET profile_id = pid WHERE profile_id IS NULL;
  ALTER TABLE orders ALTER COLUMN profile_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_orders_profile_id ON orders(profile_id);

  -- Drop old unique and create new one (if exists)
  BEGIN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_marketplace_order_id_key;
  EXCEPTION WHEN OTHERS THEN
    -- ignore
  END;
  BEGIN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_marketplace_order_id_unique;
  EXCEPTION WHEN OTHERS THEN
    -- ignore
  END;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_profile_marketplace_order_id
    ON orders(profile_id, marketplace, order_id);

  -- Suppliers: scope by profile_id
  ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL;
  UPDATE suppliers SET profile_id = pid WHERE profile_id IS NULL;
  ALTER TABLE suppliers ALTER COLUMN profile_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_suppliers_profile_id ON suppliers(profile_id);

  -- Replace global uniques with per-profile uniques (name, code)
  BEGIN
    ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_name_key;
  EXCEPTION WHEN OTHERS THEN
  END;
  BEGIN
    ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_code_key;
  EXCEPTION WHEN OTHERS THEN
  END;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_profile_name
    ON suppliers(profile_id, LOWER(TRIM(name)));
  CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_profile_code
    ON suppliers(profile_id, LOWER(TRIM(code)));

  -- Warehouses: scope by profile_id (own + supplier warehouses)
  ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL;
  UPDATE warehouses SET profile_id = pid WHERE profile_id IS NULL;
  ALTER TABLE warehouses ALTER COLUMN profile_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_warehouses_profile_id ON warehouses(profile_id);

  -- Stock movements: scope by profile_id (for safety; derived from product)
  ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL;
  UPDATE stock_movements sm
  SET profile_id = COALESCE(p.profile_id, pid)
  FROM products p
  WHERE sm.product_id = p.id AND sm.profile_id IS NULL;
  UPDATE stock_movements SET profile_id = pid WHERE profile_id IS NULL;
  ALTER TABLE stock_movements ALTER COLUMN profile_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_stock_movements_profile_product_created
    ON stock_movements(profile_id, product_id, created_at DESC);
END $$;

-- Products: make SKU unique within profile (drop global unique; add composite)
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_profile_sku ON products(profile_id, sku);

COMMIT;

