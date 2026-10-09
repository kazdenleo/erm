-- Главная: личная раскладка виджетов пользователя (NULL — раскладка по умолчанию).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS home_widgets jsonb;

COMMENT ON COLUMN users.home_widgets IS
  'Виджеты главной: { items: [{ uid, type, size: sm|md|lg, settings }] }. NULL — раскладка по умолчанию.';
