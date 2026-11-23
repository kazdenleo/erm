-- Одна активная сессия на пользователя: при новом входе version растёт, старые JWT отваливаются.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN users.session_version IS
  'Счётчик сессии: совпадает с claim sv в JWT; увеличивается при каждом новом логине';
