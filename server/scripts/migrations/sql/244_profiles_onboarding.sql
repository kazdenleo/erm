-- Онбординг self-serve: флаг завершения на аккаунте.
-- Уже существующие аккаунты с организациями считаем прошедшими онбординг.
BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN profiles.onboarding_completed_at IS
  'Когда аккаунт завершил первичный онбординг (организация / склад / МП); NULL = нужно провести wizard';

UPDATE profiles p
SET onboarding_completed_at = COALESCE(p.created_at, CURRENT_TIMESTAMP)
WHERE p.onboarding_completed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM organizations o WHERE o.profile_id = p.id
  );

COMMIT;
