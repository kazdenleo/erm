-- Migration: 230_fbo_transport_cargoes.sql
-- Description: Транспортные грузоместа Ozon FBO и привязка коробов к ним

BEGIN;

CREATE TABLE IF NOT EXISTS fbo_supply_transport_cargoes (
  id BIGSERIAL PRIMARY KEY,
  fbo_supply_id BIGINT NOT NULL REFERENCES fbo_supplies(id) ON DELETE CASCADE,
  barcode VARCHAR(64) NOT NULL,
  transport_kind VARCHAR(16) NOT NULL DEFAULT 'pallet',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_fbo_transport_kind CHECK (transport_kind IN ('pallet')),
  CONSTRAINT uq_fbo_transport_barcode UNIQUE (fbo_supply_id, barcode)
);

CREATE INDEX IF NOT EXISTS idx_fbo_transport_cargoes_supply
  ON fbo_supply_transport_cargoes (fbo_supply_id);

COMMENT ON TABLE fbo_supply_transport_cargoes IS
  'Транспортные грузоместа Ozon (ТГМ); barcode = transport_cargo_id';
COMMENT ON COLUMN fbo_supply_transport_cargoes.barcode IS
  'Ozon transport_cargo_id (как на этикетке ТГМ)';

ALTER TABLE fbo_supply_cargo_units
  ADD COLUMN IF NOT EXISTS transport_cargo_id BIGINT
    REFERENCES fbo_supply_transport_cargoes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fbo_cargo_units_transport
  ON fbo_supply_cargo_units (transport_cargo_id)
  WHERE transport_cargo_id IS NOT NULL;

COMMENT ON COLUMN fbo_supply_cargo_units.transport_cargo_id IS
  'Привязка короба/паллеты к транспортному грузоместу Ozon';

COMMIT;
