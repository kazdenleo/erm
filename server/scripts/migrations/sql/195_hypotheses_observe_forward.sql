-- Migration: 195_hypotheses_observe_forward.sql
-- Description: date_from/date_to — окно наблюдения вперёд. Если записали предыдущий период
-- (окончание = день создания), сдвигаем окно вперёд на ту же длину.

BEGIN;

UPDATE product_hypotheses h
SET
  date_from = h.date_to,
  date_to = h.date_to + (h.date_to - h.date_from),
  updated_at = NOW()
WHERE h.date_from < h.date_to
  AND h.date_to = ((h.created_at AT TIME ZONE 'Europe/Moscow')::date);

COMMIT;
