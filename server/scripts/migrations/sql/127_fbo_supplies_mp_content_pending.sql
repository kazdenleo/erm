-- Migration: 127_fbo_supplies_mp_content_pending.sql
-- Флаг несинхронизированного состава поставки с маркетплейсом

BEGIN;

ALTER TABLE fbo_supplies
    ADD COLUMN IF NOT EXISTS pending_mp_content_update BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS marketplace_content_synced_at TIMESTAMPTZ;

ALTER TABLE fbo_supply_items
    ADD COLUMN IF NOT EXISTS mp_quantity INTEGER;

COMMENT ON COLUMN fbo_supplies.pending_mp_content_update IS 'Состав поставки в ERM изменён и не отправлен на маркетплейс';
COMMENT ON COLUMN fbo_supplies.marketplace_content_synced_at IS 'Когда состав последний раз успешно отправлен на маркетплейс';
COMMENT ON COLUMN fbo_supply_items.mp_quantity IS 'Количество, подтверждённое на маркетплейсе (снимок после sync)';

-- Импортированные поставки считаем синхронизированными с МП на момент импорта
UPDATE fbo_supply_items i
SET mp_quantity = i.quantity
WHERE i.mp_quantity IS NULL;

COMMIT;
