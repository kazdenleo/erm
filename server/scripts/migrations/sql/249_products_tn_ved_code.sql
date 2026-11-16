-- ТН ВЭД как поле товара (не категории): колонка + системный атрибут + перенос из категорий.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS tn_ved_code VARCHAR(16);

COMMENT ON COLUMN products.tn_ved_code IS
  'Код ТН ВЭД ЕАЭС (10 цифр) на карточке товара; источник для МП и ERP-атрибутов';

CREATE INDEX IF NOT EXISTS idx_products_tn_ved_code
  ON products (tn_ved_code)
  WHERE tn_ved_code IS NOT NULL AND btrim(tn_ved_code) <> '';

INSERT INTO product_attributes (name, type, dictionary_values, formula, system_key, show_related_fields)
SELECT 'ТН ВЭД', 'text', '[]'::jsonb, NULL, 'tn_ved', false
WHERE NOT EXISTS (
  SELECT 1 FROM product_attributes pa WHERE pa.system_key = 'tn_ved'
);

-- Разовый перенос: пустой код товара ← код категории.
UPDATE products p
SET tn_ved_code = LEFT(REGEXP_REPLACE(TRIM(uc.tn_ved_code), '[^0-9]', '', 'g'), 16),
    updated_at = CURRENT_TIMESTAMP
FROM user_categories uc
WHERE p.user_category_id = uc.id
  AND (p.tn_ved_code IS NULL OR btrim(p.tn_ved_code) = '')
  AND uc.tn_ved_code IS NOT NULL
  AND btrim(uc.tn_ved_code) <> ''
  AND LENGTH(REGEXP_REPLACE(TRIM(uc.tn_ved_code), '[^0-9]', '', 'g')) BETWEEN 6 AND 16;
