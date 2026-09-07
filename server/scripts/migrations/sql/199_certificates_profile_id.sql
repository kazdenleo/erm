-- Сертификаты: привязка к аккаунту (profile_id), изоляция между кабинетами

BEGIN;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS profile_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE;

-- Backfill: бренд сертификата
UPDATE certificates c
SET profile_id = b.profile_id
FROM brands b
WHERE c.profile_id IS NULL
  AND c.brand_id = b.id
  AND b.profile_id IS NOT NULL;

-- Backfill: legacy-категория
UPDATE certificates c
SET profile_id = uc.profile_id
FROM user_categories uc
WHERE c.profile_id IS NULL
  AND c.user_category_id = uc.id
  AND uc.profile_id IS NOT NULL;

-- Backfill: M2M категории
UPDATE certificates c
SET profile_id = x.profile_id
FROM (
  SELECT cuc.certificate_id AS id, MIN(uc.profile_id)::bigint AS profile_id
  FROM certificate_user_categories cuc
  JOIN user_categories uc ON uc.id = cuc.user_category_id
  WHERE uc.profile_id IS NOT NULL
  GROUP BY cuc.certificate_id
) x
WHERE c.profile_id IS NULL
  AND c.id = x.id;

CREATE INDEX IF NOT EXISTS idx_certificates_profile_id ON certificates(profile_id);

COMMENT ON COLUMN certificates.profile_id IS 'Аккаунт (кабинет), которому принадлежит сертификат';

COMMIT;
