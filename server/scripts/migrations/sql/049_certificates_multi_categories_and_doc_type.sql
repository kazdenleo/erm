-- Migration: 049_certificates_multi_categories_and_doc_type.sql
-- Description: Сертификаты: тип документа + несколько категорий

BEGIN;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS document_type VARCHAR(64) NOT NULL DEFAULT 'certificate';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_certificates_document_type'
  ) THEN
    ALTER TABLE certificates
      ADD CONSTRAINT chk_certificates_document_type
      CHECK (document_type IN ('certificate', 'declaration', 'registration'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS certificate_user_categories (
  certificate_id BIGINT NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  user_category_id BIGINT NOT NULL REFERENCES user_categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (certificate_id, user_category_id)
);

CREATE INDEX IF NOT EXISTS idx_cuc_user_category_id ON certificate_user_categories(user_category_id);

-- Backfill from legacy single category field
INSERT INTO certificate_user_categories (certificate_id, user_category_id)
SELECT id, user_category_id
FROM certificates
WHERE user_category_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;

