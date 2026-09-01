-- Migration: 193_product_hypotheses.sql
-- Description: Гипотезы по товарам в аналитике: период эксперимента и сравнение с предыдущим

BEGIN;

CREATE TABLE IF NOT EXISTS product_hypotheses (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  marketplace VARCHAR(20) NOT NULL DEFAULT 'all',
  scheme VARCHAR(10) NOT NULL DEFAULT 'all',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  conclusion TEXT,
  created_by_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_product_hypotheses_dates CHECK (date_to >= date_from),
  CONSTRAINT chk_product_hypotheses_status CHECK (status IN ('active', 'completed')),
  CONSTRAINT chk_product_hypotheses_marketplace CHECK (marketplace IN ('all', 'ozon', 'wb', 'ym')),
  CONSTRAINT chk_product_hypotheses_scheme CHECK (scheme IN ('all', 'fbo', 'fbs'))
);

CREATE INDEX IF NOT EXISTS idx_product_hypotheses_profile
  ON product_hypotheses (profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_hypotheses_product
  ON product_hypotheses (profile_id, product_id, date_from DESC);

COMMENT ON TABLE product_hypotheses IS 'Гипотезы по товарам: что меняли и за какой период сравнивать продажи/прибыль';

COMMIT;
