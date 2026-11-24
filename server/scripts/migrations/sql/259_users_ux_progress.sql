-- Прогресс онбординга / демо: чеклист, скрытые подсказки, бейджи, флаги продления.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ux_progress jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.ux_progress IS
  'UX progress: checklist, hintsDismissed, badges, demoExtendedAt';
