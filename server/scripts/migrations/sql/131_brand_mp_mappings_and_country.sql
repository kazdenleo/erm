-- Migration: 131_brand_mp_mappings_and_country.sql
-- Сопоставление брендов с МП, страна производителя, вкл/выкл продвижение бренда Ozon

BEGIN;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS ozon_brand_promotion_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS manufacturer_country VARCHAR(120);

COMMENT ON COLUMN brands.ozon_brand_promotion_enabled IS
  'Учитывать ozon_brand_promotion_percent в расчёте минимальной цены Ozon';
COMMENT ON COLUMN brands.manufacturer_country IS
  'Страна производителя бренда — подставляется в карточку товара';

CREATE TABLE IF NOT EXISTS brand_marketplace_mappings (
  id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  marketplace VARCHAR(32) NOT NULL,
  mp_brand_name VARCHAR(500),
  mp_brand_id VARCHAR(255),
  mp_meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (brand_id, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_brand_mp_mappings_brand_id ON brand_marketplace_mappings(brand_id);

COMMENT ON TABLE brand_marketplace_mappings IS
  'Сопоставление ERP-бренда с названием/ID бренда на маркетплейсе';

COMMIT;
