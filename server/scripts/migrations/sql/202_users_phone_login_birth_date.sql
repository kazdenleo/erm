-- Migration: 202_users_phone_login_birth_date.sql
-- Description: Дата рождения; нормализованный телефон для входа и уникальности

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS birth_date DATE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(20);

COMMENT ON COLUMN users.birth_date IS 'Дата рождения пользователя';
COMMENT ON COLUMN users.phone_normalized IS 'Телефон в каноническом виде (цифры) для входа и уникальности';

UPDATE users u
SET phone_normalized = CASE
  WHEN length(s.d) = 11 AND left(s.d, 1) = '8' THEN '7' || substr(s.d, 2)
  WHEN length(s.d) = 10 THEN '7' || s.d
  WHEN length(s.d) BETWEEN 11 AND 15 THEN s.d
  ELSE NULL
END
FROM (
  SELECT id, regexp_replace(COALESCE(phone, ''), '\D', '', 'g') AS d
  FROM users
  WHERE phone IS NOT NULL AND btrim(phone) <> ''
) s
WHERE u.id = s.id
  AND u.phone_normalized IS NULL;

-- Если несколько пользователей с одним номером — оставляем нормализацию только у самого раннего
UPDATE users u
SET phone_normalized = NULL
WHERE u.phone_normalized IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM users u2
    WHERE u2.phone_normalized = u.phone_normalized
      AND u2.id < u.id
  );

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_normalized_uidx
  ON users (phone_normalized)
  WHERE phone_normalized IS NOT NULL;

COMMIT;
