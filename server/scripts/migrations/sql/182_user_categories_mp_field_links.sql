-- Связь полей вкладки «Основное» (название, артикул, описание, бренд, страна, габариты, rich-контент)
-- с карточками МП хранится на категории, как attribute_mp_links у атрибутов.
ALTER TABLE user_categories
  ADD COLUMN IF NOT EXISTS mp_field_links JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN user_categories.mp_field_links IS
  'Связь полей «Основное» с МП: { name?: [ozon,wb,ym], sku?: [...], description?: [...], brand?: [...], country?: [...], dimensions?: [...], product_dimensions?: [...], rich_content?: [...] }';
