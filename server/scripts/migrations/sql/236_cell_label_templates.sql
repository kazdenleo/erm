-- Шаблон этикетки ячейки адресного хранения (один на профиль)
CREATE TABLE IF NOT EXISTS cell_label_templates (
    id BIGSERIAL PRIMARY KEY,
    profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    size_preset VARCHAR(32) NOT NULL DEFAULT '58x40',
    width_mm NUMERIC(8, 2),
    height_mm NUMERIC(8, 2),
    margin_top_mm NUMERIC(6, 2) NOT NULL DEFAULT 2,
    margin_right_mm NUMERIC(6, 2) NOT NULL DEFAULT 2,
    margin_bottom_mm NUMERIC(6, 2) NOT NULL DEFAULT 2,
    margin_left_mm NUMERIC(6, 2) NOT NULL DEFAULT 2,
    line_gap_mm NUMERIC(6, 2) NOT NULL DEFAULT 1,
    elements JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_cell_label_templates_profile UNIQUE (profile_id)
);

CREATE INDEX IF NOT EXISTS idx_cell_label_templates_profile
    ON cell_label_templates(profile_id);
