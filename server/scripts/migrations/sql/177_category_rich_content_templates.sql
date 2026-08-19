CREATE TABLE IF NOT EXISTS category_rich_content_templates (
    id BIGSERIAL PRIMARY KEY,
    user_category_id BIGINT NOT NULL REFERENCES user_categories(id) ON DELETE CASCADE,
    profile_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE,
    modules JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_category_rich_content_templates_category UNIQUE (user_category_id)
);

CREATE INDEX IF NOT EXISTS idx_category_rich_content_templates_profile
    ON category_rich_content_templates(profile_id);
CREATE INDEX IF NOT EXISTS idx_category_rich_content_templates_category
    ON category_rich_content_templates(user_category_id);

COMMENT ON TABLE category_rich_content_templates IS
  'Шаблон Rich-контента категории: страница собирается из модулей, характеристики подставляются из карточки.';
