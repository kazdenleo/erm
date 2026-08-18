-- Связь ERP-атрибута с характеристиками МП хранится на категории:
-- у разных категорий Ozon/WB/ЯМ могут отличаться.
ALTER TABLE category_attributes
  ADD COLUMN IF NOT EXISTS mp_links JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN category_attributes.mp_links IS
  'Связь атрибута ERP с характеристиками Ozon/WB/ЯМ в рамках этой категории: { ozon?: {id,name}, wb?: {id,name}, ym?: {id,name} }';

-- Перенос ранее сохранённых глобальных связей как стартовых значений по категориям.
UPDATE category_attributes ca
SET mp_links = pa.mp_links
FROM product_attributes pa
WHERE pa.id = ca.attribute_id
  AND pa.mp_links IS NOT NULL
  AND pa.mp_links <> '{}'::jsonb
  AND (ca.mp_links IS NULL OR ca.mp_links = '{}'::jsonb);
