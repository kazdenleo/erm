-- Свой шаблон Rich-контента товара (переопределяет общий/категорийный).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS rich_content_modules JSONB;

COMMENT ON COLUMN products.rich_content_modules IS
  'Модули Rich-контента этого товара. NULL — используется шаблон категории или общий.';
