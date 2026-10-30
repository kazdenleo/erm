-- Подписка аккаунта: статус, план, пробный период.
-- Существующие аккаунты → active + pro (полный доступ, без блокировки).
BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS plan_code VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ NULL;

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS chk_profiles_subscription_status;
ALTER TABLE profiles
  ADD CONSTRAINT chk_profiles_subscription_status
  CHECK (subscription_status IN ('trial', 'active', 'past_due', 'suspended'));

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS chk_profiles_plan_code;
ALTER TABLE profiles
  ADD CONSTRAINT chk_profiles_plan_code
  CHECK (plan_code IS NULL OR plan_code IN ('start', 'business', 'pro'));

COMMENT ON COLUMN profiles.subscription_status IS
  'trial | active | past_due | suspended — доступ к продукту';
COMMENT ON COLUMN profiles.plan_code IS
  'Тариф: start | business | pro; NULL = не выбран (после trial)';
COMMENT ON COLUMN profiles.trial_ends_at IS
  'Конец пробного периода (обычно +7 дней от регистрации)';
COMMENT ON COLUMN profiles.subscription_ends_at IS
  'Конец оплаченного периода; NULL = бессрочно / вручную';

UPDATE profiles
SET
  subscription_status = 'active',
  plan_code = COALESCE(plan_code, 'pro'),
  tariff = COALESCE(NULLIF(TRIM(tariff), ''), 'Про')
WHERE subscription_status = 'active'
  AND (plan_code IS NULL OR trial_ends_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_profiles_subscription_status
  ON profiles (subscription_status);

CREATE INDEX IF NOT EXISTS idx_profiles_trial_ends_at
  ON profiles (trial_ends_at)
  WHERE subscription_status = 'trial';

COMMIT;
