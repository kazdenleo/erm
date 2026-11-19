-- Migration: 251_fbo_cargo_units_returned_at.sql
-- Description: Отметка приёма возврата грузоместа FBO (скан коробки)

BEGIN;

ALTER TABLE fbo_supply_cargo_units
  ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN fbo_supply_cargo_units.returned_at IS
  'Когда грузоместо принято как возврат (скан на складе); NULL — ещё не принято';

CREATE INDEX IF NOT EXISTS idx_fbo_supply_cargo_units_returned
  ON fbo_supply_cargo_units (fbo_supply_id)
  WHERE returned_at IS NOT NULL;

COMMIT;
