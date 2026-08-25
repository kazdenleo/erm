-- Локальный справочник брендов маркетплейсов (WB / Ozon / YM).
-- Обновляется ночью; в форме бренда по нему выбирают точное имя/ID для сопоставления.

BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_brand_directory (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  marketplace VARCHAR(32) NOT NULL,
  mp_brand_id VARCHAR(255),
  name VARCHAR(500) NOT NULL,
  name_norm VARCHAR(500) NOT NULL,
  source VARCHAR(32),
  meta JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mp_brand_dir_profile_mp_name
  ON marketplace_brand_directory (profile_id, marketplace, name_norm);

CREATE INDEX IF NOT EXISTS idx_mp_brand_dir_search
  ON marketplace_brand_directory (profile_id, marketplace, name_norm);

CREATE INDEX IF NOT EXISTS idx_mp_brand_dir_id
  ON marketplace_brand_directory (profile_id, marketplace, mp_brand_id)
  WHERE mp_brand_id IS NOT NULL;

COMMENT ON TABLE marketplace_brand_directory IS
  'Справочник брендов с маркетплейсов для подсказок и сопоставления в настройках бренда';

COMMIT;
