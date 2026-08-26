-- Тип атрибута «Редактируемое поле» + настройка «Показывать связанные поля»
-- (как «Название» / «Описание» в массовом редактировании: попап с полями МП).

ALTER TABLE product_attributes DROP CONSTRAINT IF EXISTS product_attributes_type_check;
ALTER TABLE product_attributes
  ADD CONSTRAINT product_attributes_type_check
  CHECK (type IN ('text', 'checkbox', 'number', 'date', 'dictionary', 'computed', 'editable'));

ALTER TABLE product_attributes
  ADD COLUMN IF NOT EXISTS show_related_fields BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN product_attributes.show_related_fields IS
  'Для type=editable: в массовом редактировании открывать попап со связанными полями МП';
