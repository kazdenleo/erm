-- Свой домен витрины (Про): хранение + статусы проверки DNS. Выпуск SSL/nginx — отдельно.
BEGIN;

ALTER TABLE online_stores
  ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255);

ALTER TABLE online_stores
  ADD COLUMN IF NOT EXISTS custom_domain_status VARCHAR(16) NOT NULL DEFAULT 'none';

ALTER TABLE online_stores
  ADD COLUMN IF NOT EXISTS custom_domain_verified_at TIMESTAMPTZ;

ALTER TABLE online_stores
  ADD COLUMN IF NOT EXISTS custom_domain_error TEXT NOT NULL DEFAULT '';

ALTER TABLE online_stores
  DROP CONSTRAINT IF EXISTS chk_online_stores_custom_domain_status;

ALTER TABLE online_stores
  ADD CONSTRAINT chk_online_stores_custom_domain_status
  CHECK (custom_domain_status IN ('none', 'pending', 'active', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_online_stores_custom_domain
  ON online_stores (lower(custom_domain))
  WHERE custom_domain IS NOT NULL AND btrim(custom_domain) <> '';

COMMENT ON COLUMN online_stores.custom_domain IS
  'Свой хост витрины (shop.example.ru). Полная привязка DNS/SSL — тариф Про (storeCustomDomain).';
COMMENT ON COLUMN online_stores.custom_domain_status IS
  'none | pending | active | failed';

COMMIT;
