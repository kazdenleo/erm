-- Редактируемые атрибуты: опция ИИ-чата в попапе редактора.
-- Ozon: хранение комплексных групп (марка/модель/модификация и др.).

BEGIN;

ALTER TABLE product_attributes
  ADD COLUMN IF NOT EXISTS ai_chat_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN product_attributes.ai_chat_enabled IS
  'Для type=editable: показывать ИИ-чат в попапе редактора (контекст из других полей карточки).';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ozon_complex_attributes JSONB;

COMMENT ON COLUMN products.ozon_complex_attributes IS
  'Комплексные атрибуты Ozon (несколько строк: марка/модель/модификация и т.п.) для complex_attributes при пуше.';

COMMIT;
