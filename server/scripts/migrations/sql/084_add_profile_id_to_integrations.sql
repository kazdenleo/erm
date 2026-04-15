-- Migration: 084_add_profile_id_to_integrations.sql
-- Description: Привязка интеграций к профилю (тенанту). Все текущие интеграции → профиль greentaxi@list.ru.

BEGIN;

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL;

DO $$
DECLARE
  pid BIGINT;
BEGIN
  SELECT u.profile_id INTO pid
  FROM users u
  WHERE LOWER(TRIM(u.email)) = LOWER(TRIM('greentaxi@list.ru'))
  ORDER BY u.id ASC
  LIMIT 1;

  IF pid IS NULL THEN
    SELECT p.id INTO pid FROM profiles p ORDER BY p.id ASC LIMIT 1;
  END IF;

  UPDATE integrations SET profile_id = pid WHERE profile_id IS NULL;
END $$;

ALTER TABLE integrations ALTER COLUMN profile_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_integrations_profile_id ON integrations(profile_id);

-- code был глобально уникален; теперь делаем уникальность по (profile_id, code)
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_profile_code ON integrations(profile_id, code);

COMMIT;

