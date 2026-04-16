BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS middle_name VARCHAR(255);

WITH parts AS (
  SELECT
    id,
    NULLIF(TRIM(split_part(COALESCE(full_name, ''), ' ', 1)), '') AS last_name_part,
    NULLIF(TRIM(split_part(COALESCE(full_name, ''), ' ', 2)), '') AS first_name_part,
    NULLIF(TRIM(regexp_replace(COALESCE(full_name, ''), '^\S+\s+\S+\s*', '')), '') AS middle_name_part
  FROM users
)
UPDATE users u
SET
  last_name = COALESCE(u.last_name, p.last_name_part),
  first_name = COALESCE(u.first_name, p.first_name_part),
  middle_name = COALESCE(u.middle_name, p.middle_name_part)
FROM parts p
WHERE p.id = u.id
  AND (u.last_name IS NULL OR u.first_name IS NULL OR u.middle_name IS NULL);

COMMIT;
