-- Migration: 010_create_orders.sql
-- Description: Создание таблицы заказов

BEGIN;

CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    marketplace VARCHAR(50) NOT NULL,
    order_id VARCHAR(255) NOT NULL,
    product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
    offer_id VARCHAR(255),
    marketplace_sku BIGINT,
    product_name VARCHAR(1000),
    quantity INTEGER NOT NULL DEFAULT 1,
    price DECIMAL(10, 2) NOT NULL,
    status VARCHAR(100),
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    delivery_address TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    in_process_at TIMESTAMP WITH TIME ZONE,
    shipment_date TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(marketplace, order_id),
    CONSTRAINT chk_marketplace CHECK (marketplace IN ('ozon', 'wb', 'ym')),
    CONSTRAINT chk_quantity CHECK (quantity > 0),
    CONSTRAINT chk_price CHECK (price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_orders_marketplace ON orders(marketplace);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(marketplace, order_id);
CREATE INDEX IF NOT EXISTS idx_orders_product_id ON orders(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

COMMENT ON TABLE orders IS 'Таблица заказов с маркетплейсов';

COMMIT;

