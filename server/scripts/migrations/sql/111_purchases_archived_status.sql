-- Migration: 111_purchases_archived_status.sql
-- Статус archived для полностью принятых закупок.

BEGIN;

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_status_check;

UPDATE purchases p
SET status = 'archived',
    completed_at = COALESCE(p.completed_at, p.updated_at, p.created_at)
WHERE EXISTS (SELECT 1 FROM purchase_items pi WHERE pi.purchase_id = p.id)
  AND NOT EXISTS (
    SELECT 1 FROM purchase_items pi
    WHERE pi.purchase_id = p.id
      AND pi.expected_quantity > COALESCE(pi.received_quantity, 0)
  );

ALTER TABLE purchases ADD CONSTRAINT purchases_status_check CHECK (status IN ('open', 'archived'));

COMMENT ON COLUMN purchases.status IS 'open — активная закупка; archived — всё принято';

COMMIT;
