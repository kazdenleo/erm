-- Передача остатков на МП: настройки на складе ERP (FBS), не на организации.
-- push_marketplace_stock = true (по умолчанию) — передавать; per-MP флаги и исключения обнуляют конкретный канал.

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS push_marketplace_stock boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_stock_ozon boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_stock_wb boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_stock_ym boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN warehouses.push_marketplace_stock IS
  'Передавать остатки на маркетплейсы (мастер-тумблер). false — обнулять все каналы.';
COMMENT ON COLUMN warehouses.push_stock_ozon IS
  'Передавать остатки на Ozon. false — обнулять и не передавать факт.';
COMMENT ON COLUMN warehouses.push_stock_wb IS
  'Передавать остатки на Wildberries.';
COMMENT ON COLUMN warehouses.push_stock_ym IS
  'Передавать остатки на Яндекс.Маркет.';

-- Перенос со старой настройки организации
UPDATE warehouses w
SET push_marketplace_stock = false
FROM organizations o
WHERE w.organization_id = o.id
  AND w.type = 'warehouse'
  AND o.skip_marketplace_stock_sync IS TRUE;

CREATE TABLE IF NOT EXISTS warehouse_marketplace_stock_exclusions (
  id bigserial PRIMARY KEY,
  warehouse_id bigint NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  marketplace text NOT NULL CHECK (marketplace IN ('ozon', 'wb', 'ym')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (warehouse_id, product_id, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_wh_mp_stock_excl_warehouse
  ON warehouse_marketplace_stock_exclusions (warehouse_id);
CREATE INDEX IF NOT EXISTS idx_wh_mp_stock_excl_product
  ON warehouse_marketplace_stock_exclusions (product_id);

COMMENT ON TABLE warehouse_marketplace_stock_exclusions IS
  'Исключения: для товара на складе остатки на указанном МП обнуляются и не передаются';
