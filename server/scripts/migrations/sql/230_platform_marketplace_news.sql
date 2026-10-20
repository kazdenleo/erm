-- Лента новостей маркетплейсов (API / крупные изменения) для супер-админа.

BEGIN;

CREATE TABLE IF NOT EXISTS platform_marketplace_news (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  published_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT platform_marketplace_news_source_external_uid UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_mp_news_published
  ON platform_marketplace_news (published_at DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS idx_platform_mp_news_source
  ON platform_marketplace_news (source);

COMMENT ON TABLE platform_marketplace_news IS
  'Автособранные новости маркетплейсов (изменения API и крупные изменения) для супер-админа';

COMMIT;
