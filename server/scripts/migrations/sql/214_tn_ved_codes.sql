-- Классификатор ТН ВЭД ЕАЭС (10-значные коды) из справочника ФНС (TNVED3/TNVED4).
-- Заполняется скриптом server/scripts/import-tnved.js; до импорта поиск работает по встроенному списку.

CREATE TABLE IF NOT EXISTS tn_ved_codes (
  code VARCHAR(10) PRIMARY KEY,
  name TEXT NOT NULL,
  level SMALLINT NOT NULL DEFAULT 0,
  position_code VARCHAR(4) NOT NULL,
  position_name TEXT,
  valid_from DATE,
  valid_to DATE,
  search_text TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tn_ved_codes_code_prefix ON tn_ved_codes (code varchar_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_tn_ved_codes_position ON tn_ved_codes (position_code);

CREATE TABLE IF NOT EXISTS tn_ved_directory_meta (
  key VARCHAR(64) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE tn_ved_codes IS 'Классификатор ТН ВЭД ЕАЭС: 10-значные коды (источник — справочник ФНС TNVED.ZIP)';
COMMENT ON COLUMN tn_ved_codes.name IS 'Краткое наименование субпозиции без ведущих тире';
COMMENT ON COLUMN tn_ved_codes.level IS 'Уровень вложенности (число тире в исходном наименовании)';
COMMENT ON COLUMN tn_ved_codes.position_name IS 'Наименование товарной позиции (4 знака)';
COMMENT ON COLUMN tn_ved_codes.search_text IS 'Нормализованный текст для поиска (lower, ё→е)';
