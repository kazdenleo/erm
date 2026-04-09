-- Migration: 070_purchase_receipts_extras_resolved.sql
-- Description: Флаг, что излишки по приёмке уже разрулены (чтобы нельзя было применить дважды).

BEGIN;

ALTER TABLE purchase_receipts
  ADD COLUMN IF NOT EXISTS extras_resolved BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN purchase_receipts.extras_resolved IS 'Излишки по приёмке разрулены (доприняты или оформлен возврат поставщику)';

COMMIT;

