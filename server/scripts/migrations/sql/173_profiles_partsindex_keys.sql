-- Ключ API PartsIndex для модуля обогащения (аккаунт / profile).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS partsindex_keys jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN profiles.partsindex_keys IS
  'Ключи PartsIndex: { "apiKey": "..." }. Auth: заголовок Authorization.';
