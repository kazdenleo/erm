-- Migration: 102_create_fbo_supplies.sql
-- Description: Поставки FBO на склады маркетплейсов

BEGIN;

CREATE TABLE IF NOT EXISTS fbo_supplies (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    profile_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
    organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
    created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'new' CHECK (status IN (
        'new', 'assembled', 'packed', 'ready_for_supply', 'shipped', 'closed', 'return'
    )),
    marketplace VARCHAR(20) NOT NULL CHECK (marketplace IN ('ozon', 'wb', 'ym')),
    name TEXT,
    ready_at DATE,
    marketplace_warehouse_name TEXT,
    marketplace_warehouse_id TEXT,
    external_shipment_number VARCHAR(128) NOT NULL,
    deduction_warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE SET NULL,
    deduct_stock BOOLEAN NOT NULL DEFAULT FALSE,
    source VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'excel', 'api')),
    external_supply_id TEXT,
    note TEXT,
    UNIQUE (profile_id, marketplace, external_shipment_number)
);

CREATE INDEX IF NOT EXISTS idx_fbo_supplies_created_at ON fbo_supplies(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fbo_supplies_status ON fbo_supplies(status);
CREATE INDEX IF NOT EXISTS idx_fbo_supplies_profile_id ON fbo_supplies(profile_id);
CREATE INDEX IF NOT EXISTS idx_fbo_supplies_org_id ON fbo_supplies(organization_id);
CREATE INDEX IF NOT EXISTS idx_fbo_supplies_marketplace ON fbo_supplies(marketplace);

CREATE TABLE IF NOT EXISTS fbo_supply_items (
    id BIGSERIAL PRIMARY KEY,
    fbo_supply_id BIGINT NOT NULL REFERENCES fbo_supplies(id) ON DELETE CASCADE,
    product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    barcode VARCHAR(64),
    sku VARCHAR(128),
    mp_offer_id VARCHAR(128),
    mp_product_id VARCHAR(64),
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fbo_supply_items_supply_id ON fbo_supply_items(fbo_supply_id);
CREATE INDEX IF NOT EXISTS idx_fbo_supply_items_product_id ON fbo_supply_items(product_id);

COMMENT ON TABLE fbo_supplies IS 'Поставки FBO на склады маркетплейсов';
COMMENT ON TABLE fbo_supply_items IS 'Строки поставки FBO: товары и количества';

COMMIT;
