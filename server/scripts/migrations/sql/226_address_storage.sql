-- Migration: 226_address_storage.sql
-- Адресное хранение: настройки склада, ячейки, закрепление товара, остатки по ячейкам, план склада.
-- Остаток «без адреса» не хранится: = product_warehouse_stock.quantity − SUM(product_location_stock).

BEGIN;

CREATE TABLE IF NOT EXISTS warehouse_address_settings (
  warehouse_id BIGINT PRIMARY KEY REFERENCES warehouses(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mode VARCHAR(16) NOT NULL DEFAULT 'fixed',
  track_quantities BOOLEAN NOT NULL DEFAULT FALSE,
  levels JSONB NOT NULL DEFAULT '[{"key":"zone","label":"Зона"},{"key":"rack","label":"Стеллаж"},{"key":"shelf","label":"Полка"},{"key":"cell","label":"Ячейка"}]'::jsonb,
  separator VARCHAR(4) NOT NULL DEFAULT '-',
  label_width_mm INTEGER NOT NULL DEFAULT 58,
  label_height_mm INTEGER NOT NULL DEFAULT 40,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_was_mode CHECK (mode IN ('fixed', 'dynamic', 'mixed'))
);

COMMENT ON TABLE warehouse_address_settings IS 'Настройки адресного хранения склада: режим, шаблон адреса, учёт количества по ячейкам';

CREATE TABLE IF NOT EXISTS storage_locations (
  id BIGSERIAL PRIMARY KEY,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  code VARCHAR(64) NOT NULL,
  parts TEXT[] NOT NULL DEFAULT '{}',
  location_type VARCHAR(16) NOT NULL DEFAULT 'storage',
  barcode VARCHAR(64),
  route_order INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_storage_locations_code UNIQUE (warehouse_id, code),
  CONSTRAINT chk_storage_locations_type CHECK (
    location_type IN ('storage', 'picking', 'receiving', 'shipping', 'defect', 'returns')
  ),
  CONSTRAINT chk_storage_locations_capacity CHECK (capacity IS NULL OR capacity >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_locations_barcode
  ON storage_locations(warehouse_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_storage_locations_route
  ON storage_locations(warehouse_id, route_order, code);

COMMENT ON TABLE storage_locations IS 'Ячейки склада; parts — части адреса по уровням шаблона';

CREATE TABLE IF NOT EXISTS product_storage_assignments (
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  location_id BIGINT NOT NULL REFERENCES storage_locations(id) ON DELETE CASCADE,
  min_qty INTEGER,
  max_qty INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_product_storage_assignments_location
  ON product_storage_assignments(location_id);

COMMENT ON TABLE product_storage_assignments IS 'Закреплённая ячейка товара на складе (одна на товар и склад)';

CREATE TABLE IF NOT EXISTS product_location_stock (
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id BIGINT NOT NULL REFERENCES storage_locations(id) ON DELETE CASCADE,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, location_id),
  CONSTRAINT chk_product_location_stock_qty CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_product_location_stock_pw
  ON product_location_stock(product_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_product_location_stock_location
  ON product_location_stock(location_id);

COMMENT ON TABLE product_location_stock IS 'Количество товара в ячейке; сумма по складу ≤ product_warehouse_stock.quantity';

CREATE TABLE IF NOT EXISTS storage_location_movements (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  from_location_id BIGINT REFERENCES storage_locations(id) ON DELETE SET NULL,
  to_location_id BIGINT REFERENCES storage_locations(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL,
  kind VARCHAR(16) NOT NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  CONSTRAINT chk_slm_qty CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_slm_warehouse_created
  ON storage_location_movements(warehouse_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slm_product_created
  ON storage_location_movements(product_id, created_at DESC);

COMMENT ON TABLE storage_location_movements IS 'Журнал размещения и перемещений между ячейками (NULL = без адреса)';
COMMENT ON COLUMN storage_location_movements.kind IS 'move — вручную; auto_out — снято при уменьшении остатка склада';

CREATE TABLE IF NOT EXISTS warehouse_layouts (
  warehouse_id BIGINT PRIMARY KEY REFERENCES warehouses(id) ON DELETE CASCADE,
  width INTEGER NOT NULL DEFAULT 40,
  height INTEGER NOT NULL DEFAULT 24,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE warehouse_layouts IS 'План склада сверху: элементы (стеллажи, зоны, проходы) в клетках сетки';

-- Остаток склада уменьшился (отгрузка, списание, перемещение) — снимаем излишек с ячеек:
-- сначала закреплённая, затем ячейки отбора, затем по маршруту.
CREATE OR REPLACE FUNCTION trim_location_stock_to_warehouse_stock()
RETURNS TRIGGER AS $$
DECLARE
  v_pid BIGINT;
  v_wid BIGINT;
  v_qty INTEGER;
  v_sum INTEGER;
  v_excess INTEGER;
  v_take INTEGER;
  r RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM product_location_stock
    WHERE product_id = OLD.product_id AND warehouse_id = OLD.warehouse_id;
    RETURN OLD;
  END IF;

  IF NEW.quantity >= OLD.quantity THEN
    RETURN NEW;
  END IF;

  v_pid := NEW.product_id;
  v_wid := NEW.warehouse_id;
  v_qty := GREATEST(COALESCE(NEW.quantity, 0), 0);

  SELECT COALESCE(SUM(quantity), 0)::int INTO v_sum
  FROM product_location_stock
  WHERE product_id = v_pid AND warehouse_id = v_wid;

  v_excess := v_sum - v_qty;
  IF v_excess <= 0 THEN
    RETURN NEW;
  END IF;

  FOR r IN
    SELECT pls.location_id, pls.quantity
    FROM product_location_stock pls
    JOIN storage_locations sl ON sl.id = pls.location_id
    LEFT JOIN product_storage_assignments a
      ON a.product_id = pls.product_id
     AND a.warehouse_id = pls.warehouse_id
     AND a.location_id = pls.location_id
    WHERE pls.product_id = v_pid AND pls.warehouse_id = v_wid
    ORDER BY (a.location_id IS NOT NULL) DESC,
             (sl.location_type = 'picking') DESC,
             sl.route_order ASC,
             sl.code ASC
    FOR UPDATE OF pls
  LOOP
    EXIT WHEN v_excess <= 0;
    v_take := LEAST(v_excess, r.quantity);
    IF v_take >= r.quantity THEN
      DELETE FROM product_location_stock
      WHERE product_id = v_pid AND location_id = r.location_id;
    ELSE
      UPDATE product_location_stock
      SET quantity = quantity - v_take, updated_at = CURRENT_TIMESTAMP
      WHERE product_id = v_pid AND location_id = r.location_id;
    END IF;
    INSERT INTO storage_location_movements
      (product_id, warehouse_id, from_location_id, to_location_id, quantity, kind, note)
    VALUES
      (v_pid, v_wid, r.location_id, NULL, v_take, 'auto_out', 'Остаток склада уменьшился');
    v_excess := v_excess - v_take;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pws_trim_location_stock ON product_warehouse_stock;
CREATE TRIGGER trg_pws_trim_location_stock
  AFTER UPDATE OR DELETE ON product_warehouse_stock
  FOR EACH ROW
  EXECUTE PROCEDURE trim_location_stock_to_warehouse_stock();

COMMIT;
