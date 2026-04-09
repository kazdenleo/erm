-- Migration: 035_add_article_prefix_to_organizations.sql
-- Description: Префикс артикулов товаров для организации

BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS article_prefix VARCHAR(50);

COMMENT ON COLUMN organizations.article_prefix IS 'Префикс артикулов товаров для данной организации (например ABC-)';

COMMIT;
