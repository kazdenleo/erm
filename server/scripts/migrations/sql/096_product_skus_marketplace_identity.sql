-- Migration: 096_product_skus_marketplace_identity.sql
-- Связка товар ↔ маркетплейс: nullable sku для Ozon при наличии только product_id,
-- JSON для дополнительных ID из ответов API (например chrt_id WB после создания карточки).

BEGIN;

ALTER TABLE product_skus
  ALTER COLUMN sku DROP NOT NULL;

COMMENT ON COLUMN product_skus.sku IS
  'Строковый идентификатор в каталоге МП: Ozon — offer_id (лимит 50 симв. в методах Seller API типа /v2/product/import); WB — nmId или иной ключ, используемый в проекте для сопоставления; Яндекс Маркет — offerId/shopSku (1–255 симв. в Partner API).';

COMMENT ON COLUMN product_skus.marketplace_product_id IS
  'Числовой ID карточки Ozon Seller API (поле product_id в ответах импорта/списка товаров).';

ALTER TABLE product_skus
  ADD COLUMN IF NOT EXISTS mp_extra JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN product_skus.mp_extra IS
  'Точки расширения: доп. ключи после вызова API создания карточки (напр. WB chrtId, imtId; ответ модерации). Не использовать для основного матчинга заказов — для этого sku и marketplace_product_id.';

ALTER TABLE product_skus DROP CONSTRAINT IF EXISTS chk_product_skus_ozon_ref;
ALTER TABLE product_skus
  ADD CONSTRAINT chk_product_skus_ozon_ref CHECK (
    marketplace <> 'ozon'
    OR sku IS NOT NULL AND btrim(sku) <> ''
    OR marketplace_product_id IS NOT NULL
  );

ALTER TABLE product_skus DROP CONSTRAINT IF EXISTS chk_product_skus_wb_ym_sku;
ALTER TABLE product_skus
  ADD CONSTRAINT chk_product_skus_wb_ym_sku CHECK (
    marketplace NOT IN ('wb', 'ym')
    OR sku IS NOT NULL AND btrim(sku) <> ''
  );

COMMIT;
