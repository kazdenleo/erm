-- Migration: 024_create_product_marketplace_prices.sql
-- Description: Хранение рассчитанных минимальных цен по маркетплейсам (для оптимизации API)

BEGIN;

CREATE TABLE IF NOT EXISTS product_marketplace_prices (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    marketplace VARCHAR(20) NOT NULL,
    min_price DECIMAL(10, 2) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_product_marketplace UNIQUE (product_id, marketplace),
    CONSTRAINT chk_min_price CHECK (min_price >= 0),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym'))
);

CREATE INDEX IF NOT EXISTS idx_product_marketplace_prices_product_id ON product_marketplace_prices(product_id);
CREATE INDEX IF NOT EXISTS idx_product_marketplace_prices_updated_at ON product_marketplace_prices(updated_at);

COMMENT ON TABLE product_marketplace_prices IS 'Рассчитанные минимальные цены товаров по маркетплейсам (обновляются ночью и при изменении товара)';

COMMIT;
