-- Атрибут товара для отображения в упаковке FBO и сборке FBS
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS packing_display_attribute_id BIGINT NULL
  REFERENCES product_attributes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_packing_display_attribute
  ON profiles (packing_display_attribute_id)
  WHERE packing_display_attribute_id IS NOT NULL;
