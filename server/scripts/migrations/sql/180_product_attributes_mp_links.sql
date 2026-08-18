ALTER TABLE product_attributes
  ADD COLUMN IF NOT EXISTS mp_links JSONB NOT NULL DEFAULT '{}'::jsonb;
