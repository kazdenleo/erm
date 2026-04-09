-- Migration: 059_kasyanov_account_admin.sql
-- Касьянов Алексей Анатольевич — администратор аккаунта (не администратор продукта: role=admin).

BEGIN;

UPDATE users
SET
  role = 'user',
  is_profile_admin = true,
  profile_id = COALESCE(
    profile_id,
    (SELECT p.id FROM profiles p ORDER BY p.id ASC LIMIT 1)
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE full_name ILIKE '%Касьянов%'
  AND full_name ILIKE '%Алексей%'
  AND full_name ILIKE '%Анатольевич%';

COMMIT;
