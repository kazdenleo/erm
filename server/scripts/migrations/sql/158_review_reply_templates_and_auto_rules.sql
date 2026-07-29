-- Шаблоны ответов на отзывы и правила автоответа (рейтинг × наличие)
BEGIN;

CREATE TABLE IF NOT EXISTS review_reply_templates (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_review_reply_templates_profile_sort
  ON review_reply_templates (profile_id, sort_order ASC, id ASC);

COMMENT ON TABLE review_reply_templates IS 'Шаблоны ответов на отзывы МП; плейсхолдеры: {{артикул}}, {{товар}}';
COMMENT ON COLUMN review_reply_templates.body IS 'Текст шаблона; плейсхолдеры: {{артикул}}, {{товар}}, {{product}}';

CREATE TABLE IF NOT EXISTS review_auto_reply_rules (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  has_text BOOLEAN NOT NULL,
  template_id BIGINT REFERENCES review_reply_templates (id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_id, rating, has_text)
);

CREATE INDEX IF NOT EXISTS idx_review_auto_reply_rules_profile
  ON review_auto_reply_rules (profile_id, enabled);

COMMENT ON TABLE review_auto_reply_rules IS
  'Автоответ на отзывы: категория = рейтинг (1–5) × наличие текста; прикреплённый шаблон';

COMMIT;
