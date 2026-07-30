-- Migration: 149_product_competitors.sql
-- Description: Конкуренты товара (ссылки на карточки МП + текущие цена/рейтинг/отзывы)

CREATE TABLE IF NOT EXISTS product_competitors (
  id BIGSERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  marketplace VARCHAR(16) NOT NULL CHECK (marketplace IN ('ozon', 'wb', 'ym')),
  url TEXT NOT NULL,
  external_id VARCHAR(64),
  title TEXT,
  price NUMERIC(12, 2),
  rating NUMERIC(4, 2),
  reviews_count INTEGER,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  alert_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT product_competitors_url_unique UNIQUE (product_id, marketplace, url)
);

CREATE INDEX IF NOT EXISTS idx_product_competitors_product_id
  ON product_competitors (product_id);

CREATE INDEX IF NOT EXISTS idx_product_competitors_marketplace
  ON product_competitors (marketplace);

CREATE INDEX IF NOT EXISTS idx_product_competitors_refresh
  ON product_competitors (last_checked_at NULLS FIRST);

COMMENT ON TABLE product_competitors IS 'Ссылки на карточки конкурентов и актуальные цена/рейтинг/число отзывов';
COMMENT ON COLUMN product_competitors.external_id IS 'nmId (WB), product/sku id (Ozon), model/sku id (YM)';
COMMENT ON COLUMN product_competitors.alert_sent_at IS 'Когда уже отправили алерт «цена ниже себестоимости» (чтобы не спамить каждый час)';
