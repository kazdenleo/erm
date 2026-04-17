-- Вопросы покупателей с маркетплейсов (синхронизация из API)
BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_questions (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  marketplace VARCHAR(32) NOT NULL,
  external_id TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL DEFAULT '',
  answer_text TEXT,
  status TEXT,
  sku_or_offer TEXT,
  source_created_at TIMESTAMPTZ,
  raw_payload JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketplace_questions_profile_mp_ext UNIQUE (profile_id, marketplace, external_id),
  CONSTRAINT marketplace_questions_marketplace_chk CHECK (marketplace IN ('ozon', 'wildberries', 'yandex'))
);

CREATE INDEX IF NOT EXISTS idx_marketplace_questions_profile_created
  ON marketplace_questions (profile_id, source_created_at DESC NULLS LAST);

COMMENT ON TABLE marketplace_questions IS 'Вопросы покупателей по данным API Ozon / Wildberries / Яндекс.Маркет';

COMMIT;
