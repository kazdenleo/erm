-- Migration: 172_create_tn_ved_bindings.sql
-- Description: Привязки кодов ТН ВЭД к бренду + категориям (как сертификаты)

BEGIN;

CREATE TABLE IF NOT EXISTS tn_ved_bindings (
  id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  tn_ved_code VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tn_ved_bindings_brand_id ON tn_ved_bindings(brand_id);
CREATE INDEX IF NOT EXISTS idx_tn_ved_bindings_code ON tn_ved_bindings(tn_ved_code);

CREATE TABLE IF NOT EXISTS tn_ved_binding_categories (
  binding_id BIGINT NOT NULL REFERENCES tn_ved_bindings(id) ON DELETE CASCADE,
  user_category_id BIGINT NOT NULL REFERENCES user_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (binding_id, user_category_id)
);

CREATE INDEX IF NOT EXISTS idx_tn_ved_binding_categories_category
  ON tn_ved_binding_categories(user_category_id);

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS tn_ved_code VARCHAR(16);

ALTER TABLE user_categories
  ADD COLUMN IF NOT EXISTS tn_ved_code VARCHAR(16);

COMMENT ON TABLE tn_ved_bindings IS 'Привязка кода ТН ВЭД к бренду (категории — через tn_ved_binding_categories)';
COMMENT ON COLUMN brands.tn_ved_code IS 'Денормализованный код ТН ВЭД для подстановки в карточки';
COMMENT ON COLUMN user_categories.tn_ved_code IS 'Денормализованный код ТН ВЭД для подстановки в карточки';

COMMIT;
