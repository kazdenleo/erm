-- Полный текст новости + прочитанность для суперадминов.

BEGIN;

ALTER TABLE platform_marketplace_news
  ADD COLUMN IF NOT EXISTS body TEXT;

COMMENT ON COLUMN platform_marketplace_news.body IS 'Полный текст новости для просмотра в админке';

-- Backfill: старые записи без body
UPDATE platform_marketplace_news
SET body = summary
WHERE body IS NULL AND summary IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_marketplace_news_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  news_id BIGINT NOT NULL REFERENCES platform_marketplace_news(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, news_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_mp_news_reads_user
  ON platform_marketplace_news_reads (user_id, read_at DESC);

COMMENT ON TABLE platform_marketplace_news_reads IS
  'Прочитанные новости маркетплейсов суперадмином (per-user)';

COMMIT;
