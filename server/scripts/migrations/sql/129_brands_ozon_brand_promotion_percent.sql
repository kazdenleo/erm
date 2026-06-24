-- Migration: 129_brands_ozon_brand_promotion_percent.sql
-- Description: Процент «Продвижение бренда» на Ozon в настройках бренда (fallback для расчёта мин. цены)

BEGIN;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS ozon_brand_promotion_percent NUMERIC(5, 2);

COMMENT ON COLUMN brands.ozon_brand_promotion_percent IS
  'Процент комиссии «Продвижение бренда» на Ozon для расчёта минимальной цены (если API не отдаёт значение)';

COMMIT;
