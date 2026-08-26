-- Системные атрибуты полей вкладки «Основное» (метаданные типа / связанных полей).
-- Значения по-прежнему в колонках products.*; записи в product_attributes — для настроек UI.

INSERT INTO product_attributes (name, type, dictionary_values, formula, system_key, show_related_fields)
SELECT v.name, v.type, '[]'::jsonb, NULL, v.system_key, v.show_related_fields
FROM (
  VALUES
    ('Название', 'editable', 'name', true),
    ('Артикул', 'text', 'sku', false),
    ('Описание', 'editable', 'description', true),
    ('Бренд', 'text', 'brand', false),
    ('Страна производителя', 'text', 'country', false),
    ('Длина товара', 'number', 'product_length', false),
    ('Ширина товара', 'number', 'product_width', false),
    ('Высота товара', 'number', 'product_height', false),
    ('Вес товара', 'number', 'product_weight', false),
    ('Длина упаковки', 'number', 'length', false),
    ('Ширина упаковки', 'number', 'width', false),
    ('Высота упаковки', 'number', 'height', false),
    ('Вес упаковки', 'number', 'weight', false)
) AS v(name, type, system_key, show_related_fields)
WHERE NOT EXISTS (
  SELECT 1 FROM product_attributes pa WHERE pa.system_key = v.system_key
);

COMMENT ON COLUMN product_attributes.system_key IS
  'Системный ключ поля карточки: price_*, name, sku, description, brand, country, product_*, length/width/height/weight';
