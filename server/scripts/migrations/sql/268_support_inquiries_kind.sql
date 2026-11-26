-- Migration: 268_support_inquiries_kind.sql
-- Тип обращения: вопрос в поддержку или идея

BEGIN;

ALTER TABLE support_inquiries
  ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT 'support';

ALTER TABLE support_inquiries
  DROP CONSTRAINT IF EXISTS support_inquiries_kind_check;

ALTER TABLE support_inquiries
  ADD CONSTRAINT support_inquiries_kind_check
  CHECK (kind IN ('support', 'idea'));

CREATE INDEX IF NOT EXISTS idx_support_inquiries_kind ON support_inquiries(kind);

COMMENT ON COLUMN support_inquiries.kind IS 'support — вопрос/проблема; idea — предложение идеи';

COMMIT;
