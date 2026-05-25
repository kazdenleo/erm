-- Migration: 106_fbo_cargo_contents_meta.sql
-- Description: Зона размещения и срок годности для строк состава грузоместа

BEGIN;

ALTER TABLE fbo_supply_cargo_contents
    ADD COLUMN IF NOT EXISTS placement_zone VARCHAR(64),
    ADD COLUMN IF NOT EXISTS expires_at DATE;

COMMENT ON COLUMN fbo_supply_cargo_contents.placement_zone IS 'Зона размещения (Ozon FBO)';
COMMENT ON COLUMN fbo_supply_cargo_contents.expires_at IS 'Срок годности до (1 дата на SKU в грузоместе)';

COMMIT;
