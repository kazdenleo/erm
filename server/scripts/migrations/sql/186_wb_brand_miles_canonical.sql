-- WB принимает бренд MILES, а не Miles. Исправляем сопоставление и поля карточек.

BEGIN;

UPDATE brand_marketplace_mappings
SET mp_brand_name = 'MILES',
    updated_at = CURRENT_TIMESTAMP
WHERE marketplace = 'wb'
  AND LOWER(TRIM(mp_brand_name)) = 'miles'
  AND mp_brand_name <> 'MILES';

UPDATE products
SET mp_wb_brand = 'MILES',
    updated_at = CURRENT_TIMESTAMP
WHERE LOWER(TRIM(mp_wb_brand)) = 'miles'
  AND mp_wb_brand <> 'MILES';

UPDATE marketplace_brand_directory
SET name = 'MILES',
    source = 'api',
    synced_at = CURRENT_TIMESTAMP
WHERE marketplace = 'wb'
  AND name_norm = 'miles'
  AND name <> 'MILES';

COMMIT;
