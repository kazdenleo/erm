-- Показатели сотрудников: пороги перерыва между сканами задаются в настройках аккаунта.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS employee_metrics_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.employee_metrics_settings IS
  'Показатели сотрудников: { idleSec: { fbs, fboCollect, packing, receipts } } — пауза между сканами длиннее порога не считается рабочим временем.';
