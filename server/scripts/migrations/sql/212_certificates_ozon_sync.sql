-- Migration: 212_certificates_ozon_sync.sql
-- Description: Поля синхронизации сертификата с разделом «Сертификаты» Ozon Seller

BEGIN;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS ozon_certificate_id BIGINT,
  ADD COLUMN IF NOT EXISTS ozon_status_code VARCHAR(64),
  ADD COLUMN IF NOT EXISTS ozon_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS ozon_accordance_type_code VARCHAR(64),
  ADD COLUMN IF NOT EXISTS ozon_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ozon_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_certificates_ozon_certificate_id
  ON certificates(ozon_certificate_id)
  WHERE ozon_certificate_id IS NOT NULL;

COMMENT ON COLUMN certificates.ozon_certificate_id IS 'ID сертификата в кабинете Ozon (Certification API)';
COMMENT ON COLUMN certificates.ozon_status_code IS 'Статус модерации сертификата на Ozon (approved/rejected/…)';
COMMENT ON COLUMN certificates.ozon_name IS 'Название сертификата, отправленное в Ozon';
COMMENT ON COLUMN certificates.ozon_accordance_type_code IS 'Тип соответствия (technical_regulations_cu / gost / …)';
COMMENT ON COLUMN certificates.ozon_synced_at IS 'Время последней успешной отправки/привязки на Ozon';
COMMENT ON COLUMN certificates.ozon_last_error IS 'Текст последней ошибки отправки на Ozon';

COMMIT;
