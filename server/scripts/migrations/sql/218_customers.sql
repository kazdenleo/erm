-- База клиентов для частных (ручных) заказов
BEGIN;

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL DEFAULT '',
  phone_normalized VARCHAR(32) NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  birthday DATE NULL,
  source VARCHAR(120) NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_profile_phone
  ON customers (profile_id, phone_normalized)
  WHERE phone_normalized <> '';

CREATE INDEX IF NOT EXISTS idx_customers_profile_name
  ON customers (profile_id, LOWER(name));

COMMENT ON TABLE customers IS 'Клиенты аккаунта для частных заказов (orders.marketplace = manual)';
COMMENT ON COLUMN customers.phone_normalized IS 'Только цифры, РФ-номера приводятся к 7XXXXXXXXXX; уникален в рамках профиля';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_id BIGINT NULL REFERENCES customers (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_customer_id
  ON orders (customer_id)
  WHERE customer_id IS NOT NULL;

-- Клиенты из уже существующих ручных заказов (по нормализованному телефону, имя — из последнего заказа)
WITH src AS (
  SELECT
    o.profile_id,
    TRIM(o.customer_name) AS customer_name,
    TRIM(COALESCE(o.customer_phone, '')) AS customer_phone,
    TRIM(COALESCE(o.delivery_address, '')) AS delivery_address,
    o.created_at,
    CASE
      WHEN LENGTH(x.d) = 11 AND LEFT(x.d, 1) = '8' THEN '7' || SUBSTRING(x.d FROM 2)
      WHEN LENGTH(x.d) = 10 THEN '7' || x.d
      ELSE x.d
    END AS pn
  FROM orders o
  CROSS JOIN LATERAL (
    SELECT REGEXP_REPLACE(COALESCE(o.customer_phone, ''), '[^0-9]', '', 'g') AS d
  ) x
  WHERE o.marketplace = 'manual'
    AND o.profile_id IS NOT NULL
    AND TRIM(COALESCE(o.customer_name, '')) <> ''
),
agg AS (
  SELECT DISTINCT ON (profile_id, pn)
    profile_id, pn, customer_name, customer_phone, delivery_address,
    MIN(created_at) OVER (PARTITION BY profile_id, pn) AS first_at
  FROM src
  WHERE pn <> ''
  ORDER BY profile_id, pn, created_at DESC
)
INSERT INTO customers (profile_id, name, phone, phone_normalized, address, source, created_at, updated_at)
SELECT profile_id, LEFT(customer_name, 255), LEFT(customer_phone, 50), pn, delivery_address,
  'Из заказов', COALESCE(first_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
FROM agg
ON CONFLICT (profile_id, phone_normalized) WHERE phone_normalized <> '' DO NOTHING;

UPDATE orders o
SET customer_id = c.id
FROM customers c
WHERE o.marketplace = 'manual'
  AND o.customer_id IS NULL
  AND c.profile_id = o.profile_id
  AND c.phone_normalized <> ''
  AND c.phone_normalized = (
    SELECT CASE
      WHEN LENGTH(x.d) = 11 AND LEFT(x.d, 1) = '8' THEN '7' || SUBSTRING(x.d FROM 2)
      WHEN LENGTH(x.d) = 10 THEN '7' || x.d
      ELSE x.d
    END
    FROM (SELECT REGEXP_REPLACE(COALESCE(o.customer_phone, ''), '[^0-9]', '', 'g') AS d) x
  );

COMMIT;
