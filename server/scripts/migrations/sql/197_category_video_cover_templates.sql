-- Шаблоны видеообложки Ozon: слайды из фото карточки + эффекты переходов.
-- Категория / общий шаблон профиля; у товара — переопределение и результат генерации.

BEGIN;

CREATE TABLE IF NOT EXISTS category_video_cover_templates (
  id BIGSERIAL PRIMARY KEY,
  user_category_id BIGINT REFERENCES user_categories(id) ON DELETE CASCADE,
  profile_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_category_video_cover_templates_scope CHECK (
    user_category_id IS NOT NULL OR profile_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_category_video_cover_templates_category
  ON category_video_cover_templates (user_category_id)
  WHERE user_category_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_category_video_cover_templates_shared_profile
  ON category_video_cover_templates (profile_id)
  WHERE user_category_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_category_video_cover_templates_profile
  ON category_video_cover_templates (profile_id);

COMMENT ON TABLE category_video_cover_templates IS
  'Шаблон видеообложки Ozon: слайды из изображений товара и эффект перехода.';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS video_cover_template JSONB;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS video_cover_slides JSONB;

COMMENT ON COLUMN products.video_cover_template IS
  'Свой шаблон видеообложки товара. NULL — шаблон категории или общий.';

COMMENT ON COLUMN products.video_cover_slides IS
  'Результат генерации: слайды, эффект, публичный URL обложки для Ozon (атрибут 21845).';

COMMIT;
