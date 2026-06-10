-- Статус заказа «В закупке» можно отключить на уровне аккаунта (резерв с наличия и «в пути» сохраняется).
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS procurement_status_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN profiles.procurement_status_enabled IS
  'false — не переводить заказы в in_procurement; резерв с наличия и incoming по-прежнему работает';
