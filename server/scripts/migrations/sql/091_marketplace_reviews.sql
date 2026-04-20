-- Отзывы покупателей с маркетплейсов (синхронизация из API)
BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  marketplace VARCHAR(32) NOT NULL,
  external_id TEXT NOT NULL,
  rating INT,
  body TEXT NOT NULL DEFAULT '',
  has_text BOOLEAN NOT NULL DEFAULT false,
  answer_text TEXT,
  status TEXT,
  sku_or_offer TEXT,
  source_created_at TIMESTAMPTZ,
  raw_payload JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketplace_reviews_profile_mp_ext UNIQUE (profile_id, marketplace, external_id),
  CONSTRAINT marketplace_reviews_marketplace_chk CHECK (marketplace IN ('ozon', 'wildberries', 'yandex')),
  CONSTRAINT marketplace_reviews_rating_chk CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5))
);

CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_profile_created
  ON marketplace_reviews (profile_id, source_created_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_profile_rating
  ON marketplace_reviews (profile_id, rating);

CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_profile_has_text
  ON marketplace_reviews (profile_id, has_text);

COMMENT ON TABLE marketplace_reviews IS 'Отзывы покупателей по данным API Ozon / Wildberries / Яндекс.Маркет';

COMMIT;

