-- Перепривязка products.brand_id к бренду того же имени в рамках profile_id товара.
-- Исправляет legacy-бренды без profile_id (например Zekkert id=4 → id=7 для profile_id=6).

UPDATE products p
SET brand_id = b_tgt.id
FROM brands b_src
JOIN brands b_tgt
  ON b_tgt.profile_id = p.profile_id
 AND LOWER(TRIM(b_tgt.name)) = LOWER(TRIM(b_src.name))
WHERE p.brand_id = b_src.id
  AND p.profile_id IS NOT NULL
  AND b_tgt.profile_id IS NOT NULL
  AND p.brand_id <> b_tgt.id
  AND (b_src.profile_id IS NULL OR b_src.profile_id IS DISTINCT FROM b_tgt.profile_id);
