-- Ключ и настройки ИИ-ассистента (GigaChat) на аккаунт / profile.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS ai_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.ai_settings IS
  'Настройки ИИ: { provider, credentials, scope, model, apiBase, enabled }. credentials — ключ авторизации GigaChat.';
