BEGIN;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE;

-- Best-effort backfill: assign brand to first profile where it's used.
UPDATE brands b
SET profile_id = x.profile_id
FROM (
  SELECT p.brand_id AS id, MIN(p.profile_id)::bigint AS profile_id
  FROM products p
  WHERE p.brand_id IS NOT NULL
    AND p.profile_id IS NOT NULL
  GROUP BY p.brand_id
) x
WHERE b.profile_id IS NULL
  AND b.id = x.id;

-- Drop global uniqueness on name (we need per-tenant uniqueness).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'brands_name_key'
  ) THEN
    ALTER TABLE brands DROP CONSTRAINT brands_name_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_brands_profile_name ON brands(profile_id, LOWER(TRIM(name)));
CREATE INDEX IF NOT EXISTS idx_brands_profile_id ON brands(profile_id);

COMMIT;
