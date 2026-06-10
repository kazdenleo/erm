-- Зона размещения Ozon FBO на строках поставки (из /v1/supply-order/bundle).

ALTER TABLE fbo_supply_items
    ADD COLUMN IF NOT EXISTS placement_zone VARCHAR(64),
    ADD COLUMN IF NOT EXISTS ozon_tags JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN fbo_supply_items.placement_zone IS 'Зона размещения Ozon FBO (SORT, NON_SORT и др.)';
COMMENT ON COLUMN fbo_supply_items.ozon_tags IS 'Теги позиции Ozon при item_tags_calculation';
