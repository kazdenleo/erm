BEGIN;

ALTER TABLE user_categories
  ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE;

-- Best-effort backfill: если категория уже используется товарами, берём первый profile_id из products.
UPDATE user_categories uc
SET profile_id = x.profile_id
FROM (
  SELECT p.user_category_id AS id, MIN(p.profile_id)::bigint AS profile_id
  FROM products p
  WHERE p.user_category_id IS NOT NULL
    AND p.profile_id IS NOT NULL
  GROUP BY p.user_category_id
) x
WHERE uc.profile_id IS NULL
  AND uc.id = x.id;

CREATE INDEX IF NOT EXISTS idx_user_categories_profile_id ON user_categories(profile_id);

COMMIT;
