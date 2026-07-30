-- Дефолт связей Main↔МП: выкл. (включаются только при создании карточки с формы).
-- Сбрасываем ранее проставленный DEFAULT «все вкл.» у существующих строк.

ALTER TABLE products
  ALTER COLUMN mp_field_links SET DEFAULT '{
    "name": [],
    "sku": [],
    "description": [],
    "brand": [],
    "country": [],
    "dimensions": []
  }'::jsonb;

UPDATE products
SET mp_field_links = '{
  "name": [],
  "sku": [],
  "description": [],
  "brand": [],
  "country": [],
  "dimensions": []
}'::jsonb;

COMMENT ON COLUMN products.mp_field_links IS
  'Связи полей Main↔МП (OZ/WB/YM). По умолчанию выкл.; при создании карточки форма включает все поддерживаемые.';
