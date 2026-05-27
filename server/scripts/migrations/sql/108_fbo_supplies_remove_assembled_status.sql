-- Migration: 108_fbo_supplies_remove_assembled_status.sql
-- Убираем статус «Собран» из поставок FBO

BEGIN;

UPDATE fbo_supplies SET status = 'packed' WHERE status = 'assembled';

ALTER TABLE fbo_supplies DROP CONSTRAINT IF EXISTS fbo_supplies_status_check;

ALTER TABLE fbo_supplies
  ADD CONSTRAINT fbo_supplies_status_check CHECK (status IN (
    'new', 'packed', 'ready_for_supply', 'shipped', 'closed', 'return'
  ));

COMMIT;
