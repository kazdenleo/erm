-- Вес тары паллеты (кг) для расчёта общего веса грузоместа.

ALTER TABLE fbo_supply_cargo_units
    ADD COLUMN IF NOT EXISTS pallet_tare_weight_kg NUMERIC(10, 3);

COMMENT ON COLUMN fbo_supply_cargo_units.pallet_tare_weight_kg IS 'Вес пустой паллеты, кг (при cargo_kind = pallet)';
