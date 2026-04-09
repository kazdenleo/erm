-- Migration: 053_support_inquiries.sql
-- Обращения пользователей в поддержку (текст + вложения), статусы для админки продукта

BEGIN;

CREATE TABLE IF NOT EXISTS support_inquiries (
    id BIGSERIAL PRIMARY KEY,
    profile_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    author_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body_text TEXT NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'completed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_inquiries_profile_id ON support_inquiries(profile_id);
CREATE INDEX IF NOT EXISTS idx_support_inquiries_author_user_id ON support_inquiries(author_user_id);
CREATE INDEX IF NOT EXISTS idx_support_inquiries_status ON support_inquiries(status);
CREATE INDEX IF NOT EXISTS idx_support_inquiries_created_at ON support_inquiries(created_at DESC);

COMMENT ON TABLE support_inquiries IS 'Обращения в поддержку: привязка к профилю (аккаунту) и автору';

CREATE TABLE IF NOT EXISTS support_inquiry_attachments (
    id BIGSERIAL PRIMARY KEY,
    inquiry_id BIGINT NOT NULL REFERENCES support_inquiries(id) ON DELETE CASCADE,
    stored_name VARCHAR(500) NOT NULL,
    original_name VARCHAR(500),
    mime_type VARCHAR(200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_inquiry_attachments_inquiry_id ON support_inquiry_attachments(inquiry_id);

COMMENT ON TABLE support_inquiry_attachments IS 'Файлы к обращению (фото и видео), хранятся на диске под uploads/inquiries/{id}/';

COMMIT;
