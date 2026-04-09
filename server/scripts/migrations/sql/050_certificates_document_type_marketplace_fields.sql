-- Migration: 050_certificates_document_type_marketplace_fields.sql
-- Description: Раздельные поля в брендах и категориях под тип документа сертификат/декларация/СГР

BEGIN;

-- brands
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS declaration_number VARCHAR(255),
  ADD COLUMN IF NOT EXISTS declaration_valid_from DATE,
  ADD COLUMN IF NOT EXISTS declaration_valid_to DATE,
  ADD COLUMN IF NOT EXISTS registration_number VARCHAR(255),
  ADD COLUMN IF NOT EXISTS registration_valid_from DATE,
  ADD COLUMN IF NOT EXISTS registration_valid_to DATE;

-- user_categories
ALTER TABLE user_categories
  ADD COLUMN IF NOT EXISTS declaration_number VARCHAR(255),
  ADD COLUMN IF NOT EXISTS declaration_valid_from DATE,
  ADD COLUMN IF NOT EXISTS declaration_valid_to DATE,
  ADD COLUMN IF NOT EXISTS registration_number VARCHAR(255),
  ADD COLUMN IF NOT EXISTS registration_valid_from DATE,
  ADD COLUMN IF NOT EXISTS registration_valid_to DATE;

-- Backfill новых полей из существующих сертификатов.
-- Если на бренд/категорию есть несколько записей одного типа — берём самую свежую (по updated_at).

-- brands: declaration
UPDATE brands b
SET
  declaration_number = lb.certificate_number,
  declaration_valid_from = lb.valid_from,
  declaration_valid_to = lb.valid_to
FROM (
  SELECT DISTINCT ON (brand_id, document_type)
    brand_id,
    document_type,
    certificate_number,
    valid_from,
    valid_to
  FROM certificates
  WHERE brand_id IS NOT NULL AND document_type = 'declaration'
  ORDER BY brand_id, document_type, COALESCE(updated_at, created_at) DESC
) lb
WHERE lb.brand_id = b.id;

-- brands: registration
UPDATE brands b
SET
  registration_number = lb.certificate_number,
  registration_valid_from = lb.valid_from,
  registration_valid_to = lb.valid_to
FROM (
  SELECT DISTINCT ON (brand_id, document_type)
    brand_id,
    document_type,
    certificate_number,
    valid_from,
    valid_to
  FROM certificates
  WHERE brand_id IS NOT NULL AND document_type = 'registration'
  ORDER BY brand_id, document_type, COALESCE(updated_at, created_at) DESC
) lb
WHERE lb.brand_id = b.id;

-- user_categories: declaration
UPDATE user_categories uc
SET
  declaration_number = lc.certificate_number,
  declaration_valid_from = lc.valid_from,
  declaration_valid_to = lc.valid_to
FROM (
  SELECT DISTINCT ON (cuc.user_category_id, c.document_type)
    cuc.user_category_id,
    c.document_type,
    c.certificate_number,
    c.valid_from,
    c.valid_to
  FROM certificate_user_categories cuc
  JOIN certificates c ON c.id = cuc.certificate_id
  WHERE cuc.user_category_id IS NOT NULL AND c.document_type = 'declaration'
  ORDER BY cuc.user_category_id, c.document_type, COALESCE(c.updated_at, c.created_at) DESC
) lc
WHERE lc.user_category_id = uc.id;

-- user_categories: registration
UPDATE user_categories uc
SET
  registration_number = lc.certificate_number,
  registration_valid_from = lc.valid_from,
  registration_valid_to = lc.valid_to
FROM (
  SELECT DISTINCT ON (cuc.user_category_id, c.document_type)
    cuc.user_category_id,
    c.document_type,
    c.certificate_number,
    c.valid_from,
    c.valid_to
  FROM certificate_user_categories cuc
  JOIN certificates c ON c.id = cuc.certificate_id
  WHERE cuc.user_category_id IS NOT NULL AND c.document_type = 'registration'
  ORDER BY cuc.user_category_id, c.document_type, COALESCE(c.updated_at, c.created_at) DESC
) lc
WHERE lc.user_category_id = uc.id;

COMMIT;

