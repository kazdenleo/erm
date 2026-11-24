-- Заполняем barcode ячеек значением, которое печатается на этикетке (effectiveBarcode),
-- чтобы скан однозначно совпадал с полем barcode.
UPDATE storage_locations
SET barcode = code,
    updated_at = CURRENT_TIMESTAMP
WHERE (barcode IS NULL OR TRIM(barcode) = '')
  AND code ~ '^[\x20-\x7E]+$';

UPDATE storage_locations
SET barcode = 'L' || id::text,
    updated_at = CURRENT_TIMESTAMP
WHERE (barcode IS NULL OR TRIM(barcode) = '')
  AND code !~ '^[\x20-\x7E]+$';
