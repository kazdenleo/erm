-- Migration: 068_purchases_and_purchase_receipts.sql
-- Description: Закупки (ожидание) и приёмки по закупке со сканированием

BEGIN;

-- Закупка: документ ожидания поставки (virtual incoming)
CREATE TABLE IF NOT EXISTS purchases (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ordered_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ordered', 'partial', 'completed', 'cancelled')),
    supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
    profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
    created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchases_created_at ON purchases(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_profile_id ON purchases(profile_id);
CREATE INDEX IF NOT EXISTS idx_purchases_org_id ON purchases(organization_id);

CREATE TABLE IF NOT EXISTS purchase_items (
    id BIGSERIAL PRIMARY KEY,
    purchase_id BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    expected_quantity INTEGER NOT NULL CHECK (expected_quantity > 0),
    received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(purchase_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_product_id ON purchase_items(product_id);

-- Приёмка по закупке: сканирование → фикс количества; остатки меняем только при завершении
CREATE TABLE IF NOT EXISTS purchase_receipts (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    purchase_id BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'scanning' CHECK (status IN ('draft', 'scanning', 'completed', 'cancelled')),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchase_receipts_purchase_id ON purchase_receipts(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_receipts_status ON purchase_receipts(status);

CREATE TABLE IF NOT EXISTS purchase_receipt_items (
    id BIGSERIAL PRIMARY KEY,
    receipt_id BIGINT NOT NULL REFERENCES purchase_receipts(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    scanned_quantity INTEGER NOT NULL DEFAULT 0 CHECK (scanned_quantity >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(receipt_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_receipt_id ON purchase_receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_purchase_receipt_items_product_id ON purchase_receipt_items(product_id);

COMMENT ON TABLE purchases IS 'Закупки: виртуальный входящий остаток incoming (ожидание поставки)';
COMMENT ON TABLE purchase_items IS 'Строки закупки: ожидаемое и уже принятое количество (частичная/повторная приёмка)';
COMMENT ON TABLE purchase_receipts IS 'Приёмка по закупке: сканирование и фиксация фактических количеств';
COMMENT ON TABLE purchase_receipt_items IS 'Строки приёмки по закупке: сколько отсканировано';

COMMIT;

