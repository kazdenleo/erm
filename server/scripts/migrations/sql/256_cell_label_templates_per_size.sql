-- Шаблоны этикеток ячеек: отдельная запись на каждый размер (size_preset)
ALTER TABLE cell_label_templates
  DROP CONSTRAINT IF EXISTS uq_cell_label_templates_profile;

ALTER TABLE cell_label_templates
  ADD CONSTRAINT uq_cell_label_templates_profile_size UNIQUE (profile_id, size_preset);

CREATE INDEX IF NOT EXISTS idx_cell_label_templates_profile_updated
  ON cell_label_templates (profile_id, updated_at DESC);
