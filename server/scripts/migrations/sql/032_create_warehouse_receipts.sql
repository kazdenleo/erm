-- Migration: 032_create_warehouse_receipts.sql
-- Description: Приёмки товаров на склад (поставщик, строки, себестоимость)

BEGIN;

CREATE TABLE IF NOT EXISTS warehouse_receipts (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    receipt_number VARCHAR(50),
    CONSTRAINT uq_receipt_number UNIQUE (receipt_number)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_receipts_created_at ON warehouse_receipts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warehouse_receipts_supplier ON warehouse_receipts(supplier_id);

CREATE TABLE IF NOT EXISTS warehouse_receipt_lines (
    id BIGSERIAL PRIMARY KEY,
    receipt_id BIGINT NOT NULL REFERENCES warehouse_receipts(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    cost DECIMAL(14, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_receipt_lines_receipt ON warehouse_receipt_lines(receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_lines_product ON warehouse_receipt_lines(product_id);

COMMENT ON TABLE warehouse_receipts IS 'Приёмки товаров на склад';
COMMENT ON TABLE warehouse_receipt_lines IS 'Строки приёмки: товар, количество, себестоимость';

COMMIT;
