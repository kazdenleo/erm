-- Migration: 042_create_certificates_and_marketplace_fields.sql
-- Description: Сертификаты соответствия + поля сертификата в brands и user_categories

BEGIN;

-- 1) Certificates table
CREATE TABLE IF NOT EXISTS certificates (
  id BIGSERIAL PRIMARY KEY,
  certificate_number VARCHAR(255) NOT NULL,
  brand_id BIGINT REFERENCES brands(id) ON DELETE SET NULL,
  user_category_id BIGINT REFERENCES user_categories(id) ON DELETE SET NULL,
  photo_url TEXT,
  valid_from DATE,
  valid_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_certificates_brand_id ON certificates(brand_id);
CREATE INDEX IF NOT EXISTS idx_certificates_user_category_id ON certificates(user_category_id);
CREATE INDEX IF NOT EXISTS idx_certificates_valid_to ON certificates(valid_to);

COMMENT ON TABLE certificates IS 'Сертификаты соответствия (для бренда/категории)';

-- 2) Marketplace-facing fields on brands
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS certificate_number VARCHAR(255),
  ADD COLUMN IF NOT EXISTS certificate_valid_from DATE,
  ADD COLUMN IF NOT EXISTS certificate_valid_to DATE;

-- 3) Marketplace-facing fields on user_categories
ALTER TABLE user_categories
  ADD COLUMN IF NOT EXISTS certificate_number VARCHAR(255),
  ADD COLUMN IF NOT EXISTS certificate_valid_from DATE,
  ADD COLUMN IF NOT EXISTS certificate_valid_to DATE;

COMMIT;

