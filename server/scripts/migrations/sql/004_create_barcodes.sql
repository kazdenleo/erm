-- Migration: 004_create_barcodes.sql
-- Description: Создание таблицы штрихкодов

BEGIN;

CREATE TABLE IF NOT EXISTS barcodes (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    barcode VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_barcodes_product_id ON barcodes(product_id);
CREATE INDEX IF NOT EXISTS idx_barcodes_barcode ON barcodes(barcode);

COMMENT ON TABLE barcodes IS 'Таблица штрихкодов товаров';
COMMENT ON COLUMN barcodes.barcode IS 'Штрихкод (уникальный)';

COMMIT;

