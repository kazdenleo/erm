CREATE TABLE IF NOT EXISTS category_label_templates (
    id BIGSERIAL PRIMARY KEY,
    user_category_id BIGINT NOT NULL REFERENCES user_categories(id) ON DELETE CASCADE,
    profile_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE,
    size_preset VARCHAR(32) NOT NULL DEFAULT '58x40',
    width_mm NUMERIC(8, 2),
    height_mm NUMERIC(8, 2),
    margin_top_mm NUMERIC(6, 2) NOT NULL DEFAULT 2,
    margin_right_mm NUMERIC(6, 2) NOT NULL DEFAULT 2,
    margin_bottom_mm NUMERIC(6, 2) NOT NULL DEFAULT 2,
    margin_left_mm NUMERIC(6, 2) NOT NULL DEFAULT 2,
    elements JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_category_label_templates_category UNIQUE (user_category_id)
);

CREATE INDEX IF NOT EXISTS idx_category_label_templates_profile
    ON category_label_templates(profile_id);
CREATE INDEX IF NOT EXISTS idx_category_label_templates_category
    ON category_label_templates(user_category_id);
