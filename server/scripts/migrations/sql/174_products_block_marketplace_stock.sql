-- Блокировка передачи остатков на МП по конкретному товару.
-- true = на маркетплейс уходит 0 и фактический остаток не передаётся.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS block_stock_ozon boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS block_stock_wb boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS block_stock_ym boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN products.block_stock_ozon IS
  'true — обнулять остаток на Ozon и не передавать фактический stock';
COMMENT ON COLUMN products.block_stock_wb IS
  'true — обнулять остаток на Wildberries и не передавать фактический stock';
COMMENT ON COLUMN products.block_stock_ym IS
  'true — обнулять остаток на Яндекс.Маркет и не передавать фактический stock';
