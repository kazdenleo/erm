-- Migration: 103_fbo_supplies_stock_deducted.sql
-- Description: Отметка фактического списания остатков по поставке FBO

BEGIN;

ALTER TABLE fbo_supplies
  ADD COLUMN IF NOT EXISTS stock_deducted_at TIMESTAMPTZ;

COMMENT ON COLUMN fbo_supplies.stock_deducted_at IS 'Когда выполнено списание остатков при переходе в «Отгружен»';

COMMIT;
