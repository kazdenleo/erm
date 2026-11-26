-- Интернет-магазин (витрина) из каталога ERP: один магазин на профиль, шаблоны, выбор товаров.
BEGIN;

CREATE TABLE IF NOT EXISTS online_stores (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  template_code VARCHAR(32) NOT NULL DEFAULT 'minimal',
  brand_color VARCHAR(16) NOT NULL DEFAULT '#0f766e',
  logo_url TEXT,
  tagline TEXT NOT NULL DEFAULT '',
  phone VARCHAR(50) NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  published BOOLEAN NOT NULL DEFAULT false,
  product_mode VARCHAR(16) NOT NULL DEFAULT 'all',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_online_stores_profile UNIQUE (profile_id),
  CONSTRAINT uq_online_stores_slug UNIQUE (slug),
  CONSTRAINT chk_online_stores_template
    CHECK (template_code IN ('minimal', 'showcase', 'catalog')),
  CONSTRAINT chk_online_stores_product_mode
    CHECK (product_mode IN ('all', 'selected')),
  CONSTRAINT chk_online_stores_slug_format
    CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$')
);

CREATE INDEX IF NOT EXISTS idx_online_stores_published_slug
  ON online_stores (slug)
  WHERE published = true;

COMMENT ON TABLE online_stores IS 'Публичная витрина аккаунта: шаблон + брендинг + выбор SKU из каталога';
COMMENT ON COLUMN online_stores.product_mode IS 'all = все товары профиля; selected = только online_store_products';

CREATE TABLE IF NOT EXISTS online_store_products (
  store_id BIGINT NOT NULL REFERENCES online_stores (id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  published BOOLEAN NOT NULL DEFAULT true,
  selling_price NUMERIC(12, 2) NULL,
  PRIMARY KEY (store_id, product_id),
  CONSTRAINT chk_online_store_products_price
    CHECK (selling_price IS NULL OR selling_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_online_store_products_store_pub
  ON online_store_products (store_id)
  WHERE published = true;

COMMENT ON TABLE online_store_products IS 'Товары витрины при product_mode=selected; selling_price перекрывает products.price';

COMMIT;
