-- barcode=code из 253 — не «свой» ШК: на этикетке нужен короткий L{id} (толстые модули).
-- Явно заданный barcode (≠ code) не трогаем.
UPDATE storage_locations
SET barcode = 'L' || id::text,
    updated_at = CURRENT_TIMESTAMP
WHERE barcode IS NOT NULL
  AND TRIM(barcode) <> ''
  AND TRIM(barcode) = TRIM(code);

UPDATE storage_locations
SET barcode = 'L' || id::text,
    updated_at = CURRENT_TIMESTAMP
WHERE barcode IS NULL OR TRIM(barcode) = '';
