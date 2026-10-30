-- Онлайн-оплата заявок на тариф (ЮKassa)
BEGIN;

ALTER TABLE subscription_requests
  ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS external_payment_id VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS confirmation_url TEXT NULL;

ALTER TABLE subscription_requests DROP CONSTRAINT IF EXISTS chk_subscription_requests_payment_provider;
ALTER TABLE subscription_requests
  ADD CONSTRAINT chk_subscription_requests_payment_provider
  CHECK (payment_provider IS NULL OR payment_provider IN ('manual', 'yookassa'));

ALTER TABLE subscription_requests DROP CONSTRAINT IF EXISTS chk_subscription_requests_payment_status;
ALTER TABLE subscription_requests
  ADD CONSTRAINT chk_subscription_requests_payment_status
  CHECK (
    payment_status IS NULL
    OR payment_status IN ('pending', 'waiting_for_capture', 'succeeded', 'canceled')
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_requests_ext_payment
  ON subscription_requests (external_payment_id)
  WHERE external_payment_id IS NOT NULL;

COMMENT ON COLUMN subscription_requests.payment_provider IS 'manual | yookassa';
COMMENT ON COLUMN subscription_requests.external_payment_id IS 'ID платежа у провайдера (ЮKassa)';

COMMIT;
