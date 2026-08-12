-- Ключи PartsAPI хранятся на аккаунте (локально в profiles), не у системного админа.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS partsapi_keys jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.partsapi_keys IS
  'Ключи PartsAPI по методам: { searchArticles, getArticleCriteria, ... }';
