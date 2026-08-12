-- Модуль обогащения карточек автозапчастей (PartsAPI / TecDoc).
-- product_enrichment_enabled: включает блок на карточке товара (только системный админ).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS product_enrichment_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS enrichment_status varchar(32) NULL,
  ADD COLUMN IF NOT EXISTS enrichment_source varchar(64) NULL,
  ADD COLUMN IF NOT EXISTS enrichment_art_id varchar(64) NULL,
  ADD COLUMN IF NOT EXISTS enrichment_matched_brand varchar(255) NULL,
  ADD COLUMN IF NOT EXISTS enrichment_matched_number varchar(255) NULL,
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS enrichment_payload jsonb NULL;

COMMENT ON COLUMN profiles.product_enrichment_enabled IS
  'Модуль обогащения карточек (PartsAPI). Включает системный администратор.';

COMMENT ON COLUMN products.enrichment_status IS
  'none|partial|full|not_found|needs_review|error';
