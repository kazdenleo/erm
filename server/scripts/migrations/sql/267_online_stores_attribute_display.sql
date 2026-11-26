-- Какие атрибуты показывать на витрине по категориям
BEGIN;

ALTER TABLE online_stores
  ADD COLUMN IF NOT EXISTS attribute_display_json JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN online_stores.attribute_display_json IS
  'Настройки показа атрибутов на PDP: { "byCategory": { "<user_category_id>": [attribute_id, ...] } }. '
  'Отсутствие ключа категории = показывать все; пустой массив = скрыть все.';

COMMIT;
