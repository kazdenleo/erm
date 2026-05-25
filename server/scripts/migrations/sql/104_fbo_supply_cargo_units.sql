-- Migration: 104_fbo_supply_cargo_units.sql
-- Description: Грузоместа (коробки/паллеты) и состав при сборке поставки FBO

BEGIN;

CREATE TABLE IF NOT EXISTS fbo_supply_cargo_units (
    id BIGSERIAL PRIMARY KEY,
    fbo_supply_id BIGINT NOT NULL REFERENCES fbo_supplies(id) ON DELETE CASCADE,
    barcode VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (fbo_supply_id, barcode)
);

CREATE INDEX IF NOT EXISTS idx_fbo_supply_cargo_units_supply_id
    ON fbo_supply_cargo_units(fbo_supply_id);

CREATE TABLE IF NOT EXISTS fbo_supply_cargo_contents (
    id BIGSERIAL PRIMARY KEY,
    cargo_unit_id BIGINT NOT NULL REFERENCES fbo_supply_cargo_units(id) ON DELETE CASCADE,
    fbo_supply_item_id BIGINT NOT NULL REFERENCES fbo_supply_items(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (cargo_unit_id, fbo_supply_item_id)
);

CREATE INDEX IF NOT EXISTS idx_fbo_supply_cargo_contents_cargo_id
    ON fbo_supply_cargo_contents(cargo_unit_id);
CREATE INDEX IF NOT EXISTS idx_fbo_supply_cargo_contents_item_id
    ON fbo_supply_cargo_contents(fbo_supply_item_id);

COMMENT ON TABLE fbo_supply_cargo_units IS 'Грузоместа поставки FBO (штрихкод коробки/паллеты)';
COMMENT ON TABLE fbo_supply_cargo_contents IS 'Товары, упакованные в грузоместо';

COMMIT;
