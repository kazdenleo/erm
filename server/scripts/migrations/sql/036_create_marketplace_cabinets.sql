CREATE TABLE IF NOT EXISTS marketplace_cabinets (
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    marketplace_type VARCHAR(32) NOT NULL CHECK (marketplace_type IN ('ozon', 'wildberries', 'yandex')),
    name VARCHAR(255) NOT NULL,
    config JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_marketplace_cabinets_org ON marketplace_cabinets(organization_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_cabinets_type ON marketplace_cabinets(marketplace_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_cabinets_wb_one_per_org
  ON marketplace_cabinets(organization_id) WHERE marketplace_type = 'wildberries';
