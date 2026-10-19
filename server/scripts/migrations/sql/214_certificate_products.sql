-- Migration: 214_certificate_products.sql
-- Description: Привязка сертификатов к конкретным товарам (+ backfill из категорий)

BEGIN;

CREATE TABLE IF NOT EXISTS certificate_products (
  certificate_id BIGINT NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (certificate_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_certificate_products_product_id
  ON certificate_products(product_id);

CREATE INDEX IF NOT EXISTS idx_certificate_products_certificate_id
  ON certificate_products(certificate_id);

-- Миграция существующих привязок «сертификат → категория» → товары этих категорий
INSERT INTO certificate_products (certificate_id, product_id)
SELECT DISTINCT cuc.certificate_id, p.id
FROM certificate_user_categories cuc
INNER JOIN products p ON p.user_category_id = cuc.user_category_id
INNER JOIN certificates c ON c.id = cuc.certificate_id
WHERE p.id IS NOT NULL
  AND (c.profile_id IS NULL OR p.profile_id IS NULL OR p.profile_id = c.profile_id)
  AND (c.brand_id IS NULL OR p.brand_id IS NULL OR p.brand_id = c.brand_id)
ON CONFLICT DO NOTHING;

COMMIT;
