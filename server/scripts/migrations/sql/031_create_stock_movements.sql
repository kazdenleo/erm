-- Migration: 031_create_stock_movements.sql
-- Description: Журнал движений остатков (для истории и FIFO-аналитики)

BEGIN;

CREATE TABLE IF NOT EXISTS stock_movements (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    type VARCHAR(32) NOT NULL,
    reason TEXT,
    quantity_change INTEGER NOT NULL,
    balance_after INTEGER,
    meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_created_at
    ON stock_movements(product_id, created_at DESC);

COMMIT;

