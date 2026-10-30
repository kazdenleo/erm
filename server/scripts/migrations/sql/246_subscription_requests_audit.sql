-- Заявки на оплату/активацию тарифа + журнал изменений подписки
BEGIN;

CREATE TABLE IF NOT EXISTS subscription_requests (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  requested_by_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  plan_code VARCHAR(32) NOT NULL,
  period VARCHAR(16) NOT NULL DEFAULT 'month',
  amount_rub INTEGER NULL,
  comment_text TEXT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  admin_note TEXT NULL,
  resolved_by_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_subscription_requests_plan
    CHECK (plan_code IN ('start', 'business', 'pro')),
  CONSTRAINT chk_subscription_requests_period
    CHECK (period IN ('month', 'year')),
  CONSTRAINT chk_subscription_requests_status
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_subscription_requests_status_created
  ON subscription_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscription_requests_profile
  ON subscription_requests (profile_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_requests_one_pending
  ON subscription_requests (profile_id)
  WHERE status = 'pending';

COMMENT ON TABLE subscription_requests IS
  'Заявка клиента на тариф (оплата вручную → активация админом)';

CREATE TABLE IF NOT EXISTS subscription_audit_log (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  actor_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(64) NOT NULL,
  from_status VARCHAR(32) NULL,
  to_status VARCHAR(32) NULL,
  from_plan_code VARCHAR(32) NULL,
  to_plan_code VARCHAR(32) NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscription_audit_profile_created
  ON subscription_audit_log (profile_id, created_at DESC);

COMMENT ON TABLE subscription_audit_log IS
  'Аудит смены тарифа/статуса подписки аккаунта';

COMMIT;
