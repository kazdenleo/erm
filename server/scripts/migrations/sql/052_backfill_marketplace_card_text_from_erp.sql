-- Однократный перенос: пустые поля карточек МП заполняем из ERP (до разделения полей данные жили в name/description/sku/brand).
-- Уже заполненные mp_* не трогаем.

BEGIN;

UPDATE products SET
  mp_ozon_name = COALESCE(NULLIF(btrim(mp_ozon_name), ''), NULLIF(left(btrim(name), 2000), '')),
  mp_wb_name = COALESCE(NULLIF(btrim(mp_wb_name), ''), NULLIF(left(btrim(name), 2000), '')),
  mp_ym_name = COALESCE(NULLIF(btrim(mp_ym_name), ''), NULLIF(left(btrim(name), 2000), '')),
  mp_ozon_description = COALESCE(NULLIF(btrim(mp_ozon_description), ''), NULLIF(btrim(description), '')),
  mp_wb_description = COALESCE(NULLIF(btrim(mp_wb_description), ''), NULLIF(btrim(description), '')),
  mp_ym_description = COALESCE(NULLIF(btrim(mp_ym_description), ''), NULLIF(btrim(description), '')),
  mp_wb_vendor_code = COALESCE(NULLIF(btrim(mp_wb_vendor_code), ''), NULLIF(left(btrim(sku), 255), ''));

-- Бренд (текст) для Ozon/WB из справочника brands, только если mp_* пустые и есть brand_id
UPDATE products p
SET
  mp_ozon_brand = COALESCE(NULLIF(btrim(p.mp_ozon_brand), ''), NULLIF(left(btrim(b.name), 500), '')),
  mp_wb_brand = COALESCE(NULLIF(btrim(p.mp_wb_brand), ''), NULLIF(left(btrim(b.name), 500), ''))
FROM brands b
WHERE p.brand_id = b.id
  AND (
    (p.mp_ozon_brand IS NULL OR btrim(p.mp_ozon_brand) = '')
    OR (p.mp_wb_brand IS NULL OR btrim(p.mp_wb_brand) = '')
  );

COMMIT;
