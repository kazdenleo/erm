-- Несколько складов одного маркетплейса на один наш склад.
-- Было: UNIQUE(warehouse_id, marketplace). Стало: UNIQUE(warehouse_id, marketplace, marketplace_warehouse_id).
BEGIN;

DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'warehouse_mappings'::regclass
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM unnest(c.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      ) = ARRAY['marketplace', 'warehouse_id']
  LOOP
    EXECUTE format('ALTER TABLE warehouse_mappings DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_warehouse_mappings_wh_mp_mpwh
  ON warehouse_mappings (warehouse_id, marketplace, marketplace_warehouse_id);

COMMENT ON TABLE warehouse_mappings IS
  'Привязки складов маркетплейсов к нашим складам: к одному складу можно привязать несколько складов каждого МП';

COMMIT;
