-- Migration: 114_order_procurement_foundation.sql
-- Description: Планирование закупок по заказам, привязка поставщиков к складам, даты закупки

BEGIN;

-- Привязка поставщиков к складу заказа (пустой список = fallback на всех активных)
CREATE TABLE IF NOT EXISTS warehouse_suppliers (
    id BIGSERIAL PRIMARY KEY,
    profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (warehouse_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_suppliers_profile_id ON warehouse_suppliers(profile_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_suppliers_warehouse_id ON warehouse_suppliers(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_suppliers_supplier_id ON warehouse_suppliers(supplier_id);

COMMENT ON TABLE warehouse_suppliers IS 'Поставщики, доступные для автозакупки на склад заказа';

-- Строки покрытия заказа: резерв / закупка / ручной выбор (идемпотентность)
CREATE TABLE IF NOT EXISTS order_fulfillment_lines (
    id BIGSERIAL PRIMARY KEY,
    profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    order_db_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    marketplace VARCHAR(20) NOT NULL,
    order_id VARCHAR(255) NOT NULL,
    line_key VARCHAR(255) NOT NULL,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    kit_product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
    quantity_needed INTEGER NOT NULL CHECK (quantity_needed > 0),
    quantity_reserved INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
    quantity_purchased INTEGER NOT NULL DEFAULT 0 CHECK (quantity_purchased >= 0),
    purchase_item_id BIGINT REFERENCES purchase_items(id) ON DELETE SET NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'reserved', 'purchased', 'partial', 'manual_required', 'cancelled')),
    manual_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (profile_id, order_db_id, line_key)
);

CREATE INDEX IF NOT EXISTS idx_order_fulfillment_lines_order_db_id ON order_fulfillment_lines(order_db_id);
CREATE INDEX IF NOT EXISTS idx_order_fulfillment_lines_product_id ON order_fulfillment_lines(product_id);
CREATE INDEX IF NOT EXISTS idx_order_fulfillment_lines_status ON order_fulfillment_lines(status);

COMMENT ON TABLE order_fulfillment_lines IS 'План покрытия заказа: резерв со склада/в пути и закупка у поставщика';
COMMENT ON COLUMN order_fulfillment_lines.line_key IS 'product:ID | kit:ID:whole | kit:ID:component:COMP_ID';

ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS ship_date DATE,
    ADD COLUMN IF NOT EXISTS planned_delivery_date DATE,
    ADD COLUMN IF NOT EXISTS supplier_warehouse_name VARCHAR(255);

COMMENT ON COLUMN purchases.ship_date IS 'Плановая дата отправки заказа поставщику';
COMMENT ON COLUMN purchases.planned_delivery_date IS 'Плановая дата поступления на склад';
COMMENT ON COLUMN purchases.supplier_warehouse_name IS 'Склад поставщика (из api_config.warehouses)';

COMMIT;
