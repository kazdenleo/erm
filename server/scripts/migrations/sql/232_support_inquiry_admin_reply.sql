-- Migration: 232_support_inquiry_admin_reply.sql
-- Ответ администратора продукта на обращение в поддержку

BEGIN;

ALTER TABLE support_inquiries
  ADD COLUMN IF NOT EXISTS admin_reply TEXT,
  ADD COLUMN IF NOT EXISTS admin_replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_replied_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN support_inquiries.admin_reply IS 'Текст ответа администратора продукта';
COMMENT ON COLUMN support_inquiries.admin_replied_at IS 'Когда сохранён ответ';
COMMENT ON COLUMN support_inquiries.admin_replied_by IS 'users.id администратора, который ответил';

COMMIT;
