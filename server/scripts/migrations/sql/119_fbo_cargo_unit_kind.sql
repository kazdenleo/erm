-- Тип грузоместа FBO: короб или паллета.

ALTER TABLE fbo_supply_cargo_units
    ADD COLUMN IF NOT EXISTS cargo_kind VARCHAR(16) NOT NULL DEFAULT 'box';

ALTER TABLE fbo_supply_cargo_units
    DROP CONSTRAINT IF EXISTS fbo_supply_cargo_units_cargo_kind_check;

ALTER TABLE fbo_supply_cargo_units
    ADD CONSTRAINT fbo_supply_cargo_units_cargo_kind_check
    CHECK (cargo_kind IN ('box', 'pallet'));

COMMENT ON COLUMN fbo_supply_cargo_units.cargo_kind IS 'Тип грузоместа: box (короб) или pallet (паллета)';
