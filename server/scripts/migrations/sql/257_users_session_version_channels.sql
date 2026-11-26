-- Две параллельные сессии: компьютер (web) и мобильное устройство (mobile).
-- Вход в одном канале инвалидирует только тот же канал.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_version_web INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS session_version_mobile INTEGER NOT NULL DEFAULT 0;

-- Переносим текущий единый счётчик в оба канала, чтобы активные JWT не отвалились сразу.
UPDATE users
SET
  session_version_web = COALESCE(session_version, 0),
  session_version_mobile = COALESCE(session_version, 0)
WHERE COALESCE(session_version_web, 0) = 0
  AND COALESCE(session_version_mobile, 0) = 0
  AND COALESCE(session_version, 0) > 0;

COMMENT ON COLUMN users.session_version_web IS
  'Счётчик web/desktop-сессии; совпадает с claim sv при ch=web';
COMMENT ON COLUMN users.session_version_mobile IS
  'Счётчик mobile-сессии; совпадает с claim sv при ch=mobile';
