-- Сброс истории остатков по товару (администратор аккаунта)
BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS allow_stock_history_reset BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN profiles.allow_stock_history_reset IS
  'Разрешить администратору аккаунта сбрасывать историю остатков по товару и задавать текущие значения';

COMMIT;
