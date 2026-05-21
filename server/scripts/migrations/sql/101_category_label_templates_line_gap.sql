ALTER TABLE category_label_templates
    ADD COLUMN IF NOT EXISTS line_gap_mm NUMERIC(6, 2) NOT NULL DEFAULT 1;
