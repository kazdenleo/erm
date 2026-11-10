-- Migration: 239_fbo_supplies_activity_drop_packed.sql
-- Убираем статус packed (→ ready_for_supply), метки активности сборки/упаковки

BEGIN;

UPDATE fbo_supplies SET status = 'ready_for_supply' WHERE status = 'packed';

ALTER TABLE fbo_supplies DROP CONSTRAINT IF EXISTS fbo_supplies_status_check;

ALTER TABLE fbo_supplies
  ADD CONSTRAINT fbo_supplies_status_check CHECK (status IN (
    'new',
    'collecting',
    'packing',
    'ready_for_supply',
    'shipped',
    'closed',
    'return'
  ));

ALTER TABLE fbo_supplies
  ADD COLUMN IF NOT EXISTS last_collect_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_pack_at TIMESTAMPTZ;

COMMENT ON COLUMN fbo_supplies.last_collect_at IS 'Последний скан сборки (для метки «Собирается», окно 5 мин)';
COMMENT ON COLUMN fbo_supplies.last_pack_at IS 'Последнее изменение упаковки (для метки «Упаковывается», окно 5 мин)';

UPDATE fbo_supplies s
SET last_collect_at = x.mx
FROM (
  SELECT fbo_supply_id, MAX(created_at) AS mx
  FROM fbo_supply_item_scans
  GROUP BY fbo_supply_id
) x
WHERE s.id = x.fbo_supply_id
  AND (s.last_collect_at IS NULL OR s.last_collect_at < x.mx);

UPDATE fbo_supplies s
SET last_pack_at = x.mx
FROM (
  SELECT cu.fbo_supply_id, MAX(COALESCE(cc.created_at, cu.created_at)) AS mx
  FROM fbo_supply_cargo_units cu
  LEFT JOIN fbo_supply_cargo_contents cc ON cc.cargo_unit_id = cu.id
  GROUP BY cu.fbo_supply_id
) x
WHERE s.id = x.fbo_supply_id
  AND (s.last_pack_at IS NULL OR s.last_pack_at < x.mx);

COMMIT;
