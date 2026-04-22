-- События от маркетплейсов (вебхуки / push API) для супер-админа и ключи приёма (заполняются позже).

BEGIN;

CREATE TABLE IF NOT EXISTS platform_notification_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  CONSTRAINT platform_notification_settings_singleton CHECK (id = 1),
  secrets JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO platform_notification_settings (id, secrets) VALUES (1, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE platform_notification_settings IS 'Ключи приёма уведомлений маркетплейсов (глобальные, супер-админ)';

CREATE TABLE IF NOT EXISTS platform_marketplace_events (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'unknown',
  event_type TEXT,
  request_method TEXT,
  path_hint TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  headers_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platform_mp_events_created ON platform_marketplace_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_mp_events_source ON platform_marketplace_events (source);

COMMENT ON TABLE platform_marketplace_events IS 'Журнал входящих уведомлений маркетплейсов для мониторинга API';

COMMIT;
