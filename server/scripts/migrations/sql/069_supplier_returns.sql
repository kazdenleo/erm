-- Migration: 069_supplier_returns.sql
-- Description: Возвраты поставщику (отдельный документ). Используется, в т.ч. для излишков по приёмке закупки.

BEGIN;

CREATE TABLE IF NOT EXISTS supplier_returns (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'completed', 'cancelled')),
    supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
    organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
    profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
    created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    purchase_id BIGINT REFERENCES purchases(id) ON DELETE SET NULL,
    purchase_receipt_id BIGINT REFERENCES purchase_receipts(id) ON DELETE SET NULL,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_supplier_returns_created_at ON supplier_returns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_status ON supplier_returns(status);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_profile_id ON supplier_returns(profile_id);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_supplier_id ON supplier_returns(supplier_id);

CREATE TABLE IF NOT EXISTS supplier_return_items (
    id BIGSERIAL PRIMARY KEY,
    supplier_return_id BIGINT NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(supplier_return_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_supplier_return_items_return_id ON supplier_return_items(supplier_return_id);
CREATE INDEX IF NOT EXISTS idx_supplier_return_items_product_id ON supplier_return_items(product_id);

COMMENT ON TABLE supplier_returns IS 'Возвраты поставщику (документ). Не обязан менять stock_actual, если оформляется из излишков до доприёмки.';
COMMENT ON TABLE supplier_return_items IS 'Строки возврата поставщику';

COMMIT;

