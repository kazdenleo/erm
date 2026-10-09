-- Код ОКПД2 товара (вкладка «Основное»); при сохранении уходит в характеристики «ОКПД» маркетплейсов.
ALTER TABLE products ADD COLUMN IF NOT EXISTS okpd2_code VARCHAR(20);

COMMENT ON COLUMN products.okpd2_code IS 'Код ОКПД2 товара, формат XX.XX.XX.XXX';

-- Уже заполненные на WB значения: характеристика «ОКПД 2» (charcID 15004292, одинаков во всех предметах WB).
UPDATE products p
SET okpd2_code = s.code
FROM (
  SELECT id,
         btrim(
           CASE jsonb_typeof(wb_attributes->'15004292')
             WHEN 'array' THEN wb_attributes->'15004292'->>0
             WHEN 'object' THEN wb_attributes->'15004292'->>'value'
             ELSE wb_attributes->>'15004292'
           END
         ) AS code
  FROM products
  WHERE jsonb_typeof(wb_attributes) = 'object'
    AND wb_attributes ? '15004292'
) s
WHERE p.id = s.id
  AND p.okpd2_code IS NULL
  AND s.code ~ '^\d{2}(\.\d{1,2}|\.\d{2}\.\d{1,2}|\.\d{2}\.\d{2}\.\d{1,3})?$';
