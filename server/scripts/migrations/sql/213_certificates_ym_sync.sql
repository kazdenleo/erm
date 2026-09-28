-- Migration: 213_certificates_ym_sync.sql
-- Description: Поля синхронизации сертификата с «Товары → Документы» Яндекс.Маркета

BEGIN;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS ym_document_id BIGINT,
  ADD COLUMN IF NOT EXISTS ym_status_code VARCHAR(64),
  ADD COLUMN IF NOT EXISTS ym_document_type VARCHAR(64),
  ADD COLUMN IF NOT EXISTS ym_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ym_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_certificates_ym_document_id
  ON certificates(ym_document_id)
  WHERE ym_document_id IS NOT NULL;

COMMENT ON COLUMN certificates.ym_document_id IS 'ID документа в кабинете Яндекс.Маркета (offers/documents)';
COMMENT ON COLUMN certificates.ym_status_code IS 'Статус документа на YM (ACTIVE/VALIDATING/NOT_FOUND/…)';
COMMENT ON COLUMN certificates.ym_document_type IS 'Тип документа YM (CONFORMITY_CERTIFICATE/…)';
COMMENT ON COLUMN certificates.ym_synced_at IS 'Время последней успешной отправки/привязки на YM';
COMMENT ON COLUMN certificates.ym_last_error IS 'Текст последней ошибки отправки на Яндекс.Маркет';

COMMIT;
