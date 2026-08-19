-- Общий шаблон Rich-контента профиля (один на все категории без своего).

ALTER TABLE category_rich_content_templates
  ALTER COLUMN user_category_id DROP NOT NULL;

ALTER TABLE category_rich_content_templates
  DROP CONSTRAINT IF EXISTS uq_category_rich_content_templates_category;

CREATE UNIQUE INDEX IF NOT EXISTS uq_category_rich_content_templates_category
  ON category_rich_content_templates (user_category_id)
  WHERE user_category_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_category_rich_content_templates_shared_profile
  ON category_rich_content_templates (profile_id)
  WHERE user_category_id IS NULL;

ALTER TABLE category_rich_content_templates
  DROP CONSTRAINT IF EXISTS chk_category_rich_content_templates_shared_profile;

ALTER TABLE category_rich_content_templates
  ADD CONSTRAINT chk_category_rich_content_templates_shared_profile
  CHECK (user_category_id IS NOT NULL OR profile_id IS NOT NULL);

COMMENT ON TABLE category_rich_content_templates IS
  'Шаблон Rich-контента: по категории или общий для профиля (user_category_id IS NULL).';
