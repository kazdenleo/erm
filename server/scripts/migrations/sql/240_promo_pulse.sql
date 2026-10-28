-- Универсальный «пульс» акций: политики, привязки, состояние фаз, логи прогонов

CREATE TABLE IF NOT EXISTS promo_pulse_policies (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  marketplaces JSONB NOT NULL DEFAULT '["ozon"]'::jsonb,
  action_kinds JSONB NOT NULL DEFAULT '["elastic","percent_off","stock","other"]'::jsonb,
  phase_a_days INT NOT NULL DEFAULT 14 CHECK (phase_a_days >= 1 AND phase_a_days <= 90),
  phase_b_days INT NOT NULL DEFAULT 7 CHECK (phase_b_days >= 1 AND phase_b_days <= 60),
  max_b_share_30d NUMERIC(4, 3) NOT NULL DEFAULT 0.333
    CHECK (max_b_share_30d > 0 AND max_b_share_30d <= 1),
  require_profit_ge_markup BOOLEAN NOT NULL DEFAULT true,
  allow_below_floor_stock BOOLEAN NOT NULL DEFAULT false,
  new_product_base_days INT NOT NULL DEFAULT 14 CHECK (new_product_base_days >= 0 AND new_product_base_days <= 90),
  dry_run BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_promo_pulse_policies_profile
  ON promo_pulse_policies (profile_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_pulse_policies_default_per_profile
  ON promo_pulse_policies (profile_id)
  WHERE is_default = true;

COMMENT ON TABLE promo_pulse_policies IS 'Политики пульса акций (фазы A/B/C), МП-агностичные';

CREATE TABLE IF NOT EXISTS promo_pulse_assignments (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  policy_id BIGINT NOT NULL REFERENCES promo_pulse_policies(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE CASCADE,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
  user_category_id BIGINT REFERENCES user_categories(id) ON DELETE CASCADE,
  segment VARCHAR(32) NOT NULL DEFAULT 'normal'
    CHECK (segment IN ('hero', 'normal', 'stock', 'new')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT promo_pulse_assignments_one_target CHECK (
    (product_id IS NOT NULL)::int
      + (organization_id IS NOT NULL)::int
      + (user_category_id IS NOT NULL)::int
    = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_promo_pulse_assignments_profile
  ON promo_pulse_assignments (profile_id);
CREATE INDEX IF NOT EXISTS idx_promo_pulse_assignments_product
  ON promo_pulse_assignments (product_id)
  WHERE product_id IS NOT NULL;

COMMENT ON TABLE promo_pulse_assignments IS 'Привязка сегмента/политики пульса к товару, категории или организации';

CREATE TABLE IF NOT EXISTS promo_pulse_state (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  marketplace VARCHAR(16) NOT NULL,
  action_external_id VARCHAR(64) NOT NULL,
  our_product_id BIGINT REFERENCES products(id) ON DELETE CASCADE,
  external_product_id VARCHAR(64),
  phase VARCHAR(8) NOT NULL DEFAULT 'A' CHECK (phase IN ('A', 'B', 'C')),
  phase_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  target_price NUMERIC(12, 2),
  target_level NUMERIC(8, 2),
  last_decision JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_pulse_state_key
  ON promo_pulse_state (
    profile_id,
    marketplace,
    action_external_id,
    COALESCE(our_product_id, 0),
    COALESCE(external_product_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_promo_pulse_state_profile_mp
  ON promo_pulse_state (profile_id, marketplace);

COMMENT ON TABLE promo_pulse_state IS 'Текущая фаза пульса по товару и акции МП';

CREATE TABLE IF NOT EXISTS promo_pulse_runs (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  policy_id BIGINT REFERENCES promo_pulse_policies(id) ON DELETE SET NULL,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  marketplaces JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'completed',
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_promo_pulse_runs_profile
  ON promo_pulse_runs (profile_id, started_at DESC);

CREATE TABLE IF NOT EXISTS promo_pulse_run_items (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES promo_pulse_runs(id) ON DELETE CASCADE,
  marketplace VARCHAR(16) NOT NULL,
  action_external_id VARCHAR(64),
  our_product_id BIGINT,
  external_product_id VARCHAR(64),
  command_type VARCHAR(32),
  command JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  ok BOOLEAN,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_promo_pulse_run_items_run
  ON promo_pulse_run_items (run_id);
