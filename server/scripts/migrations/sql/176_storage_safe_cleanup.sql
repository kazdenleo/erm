-- Безопасная экономия места без изменения бизнес-логики:
-- 1) удалить неиспользуемые индексы (idx_scan = 0 на проде)
-- 2) обнулить raw_payload у отзывов (в API не отдаётся, для ответа не нужен)

DROP INDEX IF EXISTS idx_orders_profile_id;
DROP INDEX IF EXISTS idx_orders_marketplace;
DROP INDEX IF EXISTS idx_orders_assembled_at;
DROP INDEX IF EXISTS idx_orders_stock_problem;
DROP INDEX IF EXISTS idx_cache_entries_value;

UPDATE marketplace_reviews
SET raw_payload = NULL
WHERE raw_payload IS NOT NULL;
