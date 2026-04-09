-- Migration: 060_backfill_organizations_profile_id.sql
-- Description: Заполнение profile_id у организаций, созданных до колонки или без привязки (один аккаунт в системе)

BEGIN;

UPDATE organizations o
SET profile_id = (SELECT id FROM profiles ORDER BY id LIMIT 1)
WHERE o.profile_id IS NULL
  AND (SELECT COUNT(*)::int FROM profiles) = 1;

COMMIT;
