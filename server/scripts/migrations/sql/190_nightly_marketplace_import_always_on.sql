-- Финансовый ночной импорт МП включён для всех организаций (галочка убрана из UI).
UPDATE organizations
SET nightly_import_marketplace_data = true
WHERE nightly_import_marketplace_data IS DISTINCT FROM true;

COMMENT ON COLUMN organizations.nightly_import_marketplace_data IS
  'Устарело: FBO/FBS/остатки/выкуп импортируются ночью всегда. Колонка сохранена для совместимости.';
