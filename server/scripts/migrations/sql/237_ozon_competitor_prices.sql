-- Migration: 237_ozon_competitor_prices.sql
-- Description: Минимальная цена конкурентов на Ozon (индекс цен Seller API) по нашим товарам

CREATE TABLE IF NOT EXISTS ozon_competitor_prices (
  id BIGSERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  offer_id VARCHAR(128) NOT NULL,
  competitor_min_price NUMERIC(12, 2),
  external_min_price NUMERIC(12, 2),
  price_index_value NUMERIC(12, 4),
  color_index VARCHAR(32),
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ozon_competitor_prices_product_offer_unique UNIQUE (product_id, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_ozon_competitor_prices_product_id
  ON ozon_competitor_prices (product_id);

COMMENT ON TABLE ozon_competitor_prices IS 'Минимальная цена конкурентов на Ozon и на других площадках из price_indexes Seller API';
COMMENT ON COLUMN ozon_competitor_prices.competitor_min_price IS 'ozon_index_data.min_price — минимум у других продавцов на Ozon, не наша цена';
COMMENT ON COLUMN ozon_competitor_prices.external_min_price IS 'external_index_data.min_price — минимум на других площадках';
COMMENT ON COLUMN ozon_competitor_prices.color_index IS 'GREEN / YELLOW / RED / WITHOUT_INDEX';
