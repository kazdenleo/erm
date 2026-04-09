-- Migration: 039_add_profile_id_to_organizations.sql
-- Description: Привязка организаций к профилю

BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_profile_id ON organizations(profile_id);
COMMENT ON COLUMN organizations.profile_id IS 'Профиль (кабинет), к которому относится организация';

COMMIT;
