-- Migration: 198_fbo_supplies_collecting_packing_status.sql
-- Статусы «Сборка» и «Упаковка» для поставок FBO

BEGIN;

ALTER TABLE fbo_supplies DROP CONSTRAINT IF EXISTS fbo_supplies_status_check;

ALTER TABLE fbo_supplies
  ADD CONSTRAINT fbo_supplies_status_check CHECK (status IN (
    'new',
    'collecting',
    'packing',
    'packed',
    'ready_for_supply',
    'shipped',
    'closed',
    'return'
  ));

COMMIT;
