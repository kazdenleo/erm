-- Классификатор ОКПД2 (ОК 034-2014) для выбора кода в категории и карточке товара.
-- Заполняется services/okpd2Directory.service.js (при первом поиске или npm run import-okpd2).

CREATE TABLE IF NOT EXISTS okpd2_codes (
  code VARCHAR(12) PRIMARY KEY,
  name TEXT NOT NULL,
  parent_code VARCHAR(12),
  is_leaf BOOLEAN NOT NULL DEFAULT false,
  search_text TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_okpd2_codes_code_prefix ON okpd2_codes (code varchar_pattern_ops);

CREATE TABLE IF NOT EXISTS okpd2_directory_meta (
  key VARCHAR(64) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE okpd2_codes IS 'Классификатор ОКПД2: код в формате XX.XX.XX.XXX и наименование';
COMMENT ON COLUMN okpd2_codes.search_text IS 'Нормализованный текст для поиска (lower, ё→е)';

ALTER TABLE user_categories ADD COLUMN IF NOT EXISTS okpd2_code VARCHAR(20);
COMMENT ON COLUMN user_categories.okpd2_code IS 'Код ОКПД2 категории: подставляется в товары без кода и заменяет прежний код категории';
