-- Подготовка редактора витрины (Про): theme_json + layout_json (блоки страницы).
BEGIN;

ALTER TABLE online_stores
  ADD COLUMN IF NOT EXISTS theme_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE online_stores
  ADD COLUMN IF NOT EXISTS layout_json jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN online_stores.theme_json IS
  'Тема витрины (цвета, шрифты, радиусы). Полное редактирование — тариф Про (storeEditor).';
COMMENT ON COLUMN online_stores.layout_json IS
  'Раскладка блоков витрины { version, blocks[] }. Редактор блоков — тариф Про.';

COMMIT;
