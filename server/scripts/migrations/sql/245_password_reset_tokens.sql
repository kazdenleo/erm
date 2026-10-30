-- Токены восстановления пароля (одноразовые, хеш SHA-256)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_uidx
  ON password_reset_tokens (token_hash);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens (user_id);

COMMENT ON TABLE password_reset_tokens IS 'Одноразовые ссылки сброса пароля; в БД только SHA-256 хеш токена';
