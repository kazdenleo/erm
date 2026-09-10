-- Настройки in-app уведомлений аккаунта (получатели ДР и т.п.).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notification_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.notification_settings IS
  'Уведомления аккаунта: { birthdayRecipientUserIds: number[] }. За 10 дней до ДР сотрудника — runtime-уведомление выбранным пользователям.';
