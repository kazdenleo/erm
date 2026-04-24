-- Артикул продавца WB (vendorCode) по nmId из Content API — для сопоставления себестоимости,
-- когда в карточке в product_skus указан vendorCode, а в отчёте склада — nmId/chrtId.

ALTER TABLE marketplace_inventory_snapshot_lines
  ADD COLUMN IF NOT EXISTS wb_vendor_code TEXT NULL;

COMMENT ON COLUMN marketplace_inventory_snapshot_lines.wb_vendor_code IS
  'Wildberries: артикул продавца (vendorCode) с карточки по nmId; для JOIN с product_skus.sku';
