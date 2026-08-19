-- Заявки покупателей на возврат (Ozon rFBS / WB claims / YM returns awaiting decision)
BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_return_claims (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  marketplace VARCHAR(32) NOT NULL,
  external_id TEXT NOT NULL,
  status TEXT,
  needs_decision BOOLEAN NOT NULL DEFAULT TRUE,
  buyer_comment TEXT,
  seller_comment TEXT,
  reason TEXT,
  product_name TEXT,
  sku_or_offer TEXT,
  order_id TEXT,
  price NUMERIC,
  currency TEXT,
  photos JSONB NOT NULL DEFAULT '[]'::jsonb,
  available_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  campaign_id TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB,
  source_created_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT marketplace_return_claims_profile_mp_ext UNIQUE (profile_id, marketplace, external_id),
  CONSTRAINT marketplace_return_claims_marketplace_chk CHECK (marketplace IN ('ozon', 'wildberries', 'yandex'))
);

CREATE INDEX IF NOT EXISTS idx_marketplace_return_claims_profile_decision
  ON marketplace_return_claims (profile_id, needs_decision, source_created_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_marketplace_return_claims_profile_mp
  ON marketplace_return_claims (profile_id, marketplace, needs_decision);

COMMENT ON TABLE marketplace_return_claims IS 'Заявки на возврат покупателей (решение продавца) с Ozon / Wildberries / Яндекс.Маркет';

COMMIT;
