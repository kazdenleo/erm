-- Кэш остатков поставщиков для комплектов (пересчёт из комплектующих)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS kit_supplier_stock integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN products.kit_supplier_stock IS
  'Для product_type=kit: суммарный «остаток поставщиков» (min по комплектующим), пересчитывается при изменении остатков комплектующих';
