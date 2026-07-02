-- Шаблоны быстрых ответов на вопросы покупателей (по профилю аккаунта)
BEGIN;

CREATE TABLE IF NOT EXISTS question_answer_templates (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_question_answer_templates_profile_sort
  ON question_answer_templates (profile_id, sort_order ASC, id ASC);

COMMENT ON TABLE question_answer_templates IS 'Шаблоны ответов на вопросы МП; в body можно использовать {{имя}} или {{name}}';
COMMENT ON COLUMN question_answer_templates.body IS 'Текст шаблона; плейсхолдеры: {{имя}}, {{name}}';

COMMIT;
