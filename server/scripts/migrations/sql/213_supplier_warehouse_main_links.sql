-- Склад поставщика может относиться к нескольким нашим складам.
-- warehouses.main_warehouse_id остаётся первым выбранным складом (совместимость со старыми запросами).
CREATE TABLE IF NOT EXISTS supplier_warehouse_main_links (
  supplier_warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  main_warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (supplier_warehouse_id, main_warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_supplier_warehouse_main_links_main
  ON supplier_warehouse_main_links(main_warehouse_id);

INSERT INTO supplier_warehouse_main_links (supplier_warehouse_id, main_warehouse_id)
SELECT id, main_warehouse_id
FROM warehouses
WHERE main_warehouse_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMENT ON TABLE supplier_warehouse_main_links IS 'Склады поставщика ↔ наши склады (многие ко многим)';
