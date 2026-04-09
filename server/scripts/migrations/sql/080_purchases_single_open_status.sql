-- Migration: 080_purchases_single_open_status.sql
-- Упрощение: закупка без черновика/промежуточных статусов — только open; incoming сразу при создании/добавлении строк.

BEGIN;

CREATE TEMP TABLE _purchase_migration_drafts ON COMMIT DROP AS
SELECT id FROM purchases WHERE status = 'draft';

-- Уже «активированные» закупки: зафиксировать ordered_at для логики резервов/истории
UPDATE purchases
SET ordered_at = COALESCE(ordered_at, updated_at, created_at)
WHERE status IN ('ordered', 'partial', 'completed');

-- Бэкфилл incoming по бывшим черновикам (incoming раньше не начислялся до markOrdered)
DO $$
DECLARE
  r RECORD;
  cur_inc int;
  new_inc int;
BEGIN
  FOR r IN
    SELECT pi.purchase_id,
           pi.product_id,
           GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity, 0))::int AS rem
    FROM purchase_items pi
    INNER JOIN _purchase_migration_drafts d ON d.id = pi.purchase_id
  LOOP
    IF r.rem IS NULL OR r.rem <= 0 THEN
      CONTINUE;
    END IF;
    PERFORM 1 FROM products WHERE id = r.product_id FOR UPDATE;
    SELECT COALESCE(incoming_quantity, 0)::int INTO cur_inc FROM products WHERE id = r.product_id;
    new_inc := cur_inc + r.rem;
    UPDATE products
    SET incoming_quantity = new_inc, updated_at = CURRENT_TIMESTAMP
    WHERE id = r.product_id;
    INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta)
    VALUES (
      r.product_id,
      'incoming',
      r.rem,
      new_inc,
      format('Закупка №%s — ожидание (миграция)', r.purchase_id),
      jsonb_build_object('purchase_id', r.purchase_id, 'migration_backfill', true)
    );
  END LOOP;
END $$;

UPDATE purchases
SET ordered_at = COALESCE(ordered_at, CURRENT_TIMESTAMP)
WHERE id IN (SELECT id FROM _purchase_migration_drafts);

-- Сначала снять старый CHECK (там нет значения open), затем выставить статус и добавить новый ограничитель
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_status_check;

-- Единый статус (включая бывшие cancelled — трактуем как открытые; при необходимости разрулите вручную до миграции)
UPDATE purchases SET status = 'open' WHERE status IS DISTINCT FROM 'open';

ALTER TABLE purchases ADD CONSTRAINT purchases_status_check CHECK (status = 'open');

ALTER TABLE purchases ALTER COLUMN status SET DEFAULT 'open';

COMMIT;
