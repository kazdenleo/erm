-- Финансовый ночной импорт МП всегда включён (галочка в UI убрана).
-- Колонка могла отсутствовать, если старая миграция 189 не выкатывалась.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS nightly_import_marketplace_data boolean NOT NULL DEFAULT true;

UPDATE organizations
SET nightly_import_marketplace_data = true
WHERE nightly_import_marketplace_data IS DISTINCT FROM true;

COMMENT ON COLUMN organizations.nightly_import_marketplace_data IS
  'Устарело: FBO/FBS/остатки/выкуп импортируются ночью всегда. Колонка сохранена для совместимости.';
