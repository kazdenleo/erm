-- Migration: 054_demote_kazakov_system_admin.sql
-- Казаков Д.Л. — только администратор аккаунта (профиля), не администратор системы

BEGIN;

UPDATE users
SET
  role = 'user',
  is_profile_admin = true,
  updated_at = CURRENT_TIMESTAMP
WHERE full_name ILIKE '%Казаков%'
  AND full_name ILIKE '%Денис%'
  AND full_name ILIKE '%Леонидович%';

COMMIT;
