-- Migration: 033_create_organizations_and_fk.sql
-- Description: Организации; привязка товаров, складов и приёмок к организации

BEGIN;

-- Таблица организаций
CREATE TABLE IF NOT EXISTS organizations (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    inn VARCHAR(20),
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations(name);
COMMENT ON TABLE organizations IS 'Организации (юрлица), в рамках которых ведутся товары, склады и приёмки';

-- Привязка товаров к организации (nullable для обратной совместимости)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_organization_id ON products(organization_id);

-- Привязка складов к организации
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_warehouses_organization_id ON warehouses(organization_id);

-- Привязка приёмок к организации
ALTER TABLE warehouse_receipts
  ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_warehouse_receipts_organization_id ON warehouse_receipts(organization_id);

COMMIT;
