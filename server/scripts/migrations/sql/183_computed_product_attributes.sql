-- Вычисляемые атрибуты: формула на справочнике, ручное переопределение на товаре.
-- Системные поля карточки: «Цена до скидки» и «Цена после скидки».

ALTER TABLE product_attributes DROP CONSTRAINT IF EXISTS product_attributes_type_check;
ALTER TABLE product_attributes
  ADD CONSTRAINT product_attributes_type_check
  CHECK (type IN ('text', 'checkbox', 'number', 'date', 'dictionary', 'computed'));

ALTER TABLE product_attributes
  ADD COLUMN IF NOT EXISTS formula TEXT,
  ADD COLUMN IF NOT EXISTS system_key VARCHAR(64);

COMMENT ON COLUMN product_attributes.formula IS 'Формула вычисляемого поля: {cost} * 1.5, {Имя атрибута} + 10';
COMMENT ON COLUMN product_attributes.system_key IS 'Системный ключ постоянного атрибута карточки (price_before_discount / price_after_discount)';

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_attributes_system_key
  ON product_attributes (system_key)
  WHERE system_key IS NOT NULL AND btrim(system_key) <> '';

ALTER TABLE product_attribute_values
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN product_attribute_values.is_manual IS 'true = значение задано вручную, формулу не пересчитывать';

INSERT INTO product_attributes (name, type, dictionary_values, formula, system_key)
SELECT 'Цена до скидки', 'computed', '[]'::jsonb, '', 'price_before_discount'
WHERE NOT EXISTS (
  SELECT 1 FROM product_attributes WHERE system_key = 'price_before_discount'
);

INSERT INTO product_attributes (name, type, dictionary_values, formula, system_key)
SELECT 'Цена после скидки', 'computed', '[]'::jsonb, '', 'price_after_discount'
WHERE NOT EXISTS (
  SELECT 1 FROM product_attributes WHERE system_key = 'price_after_discount'
);

UPDATE product_attributes
SET type = 'computed'
WHERE system_key IN ('price_before_discount', 'price_after_discount')
  AND type IS DISTINCT FROM 'computed';
