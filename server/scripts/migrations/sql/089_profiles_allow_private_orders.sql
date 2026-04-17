-- Разрешение на частные (ручные) заказы в общих настройках аккаунта
BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS allow_private_orders BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.allow_private_orders IS 'Выполнять частные заказы: создание вручную и фильтр в списке';

COMMIT;
