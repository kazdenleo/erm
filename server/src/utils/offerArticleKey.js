/**
 * Нормализация артикула продавца для сопоставления Ozon offer_id ↔ product_skus/products.sku.
 * Примеры: DTTG5102x2 ≈ DTTG-5102x2 ≈ DTTG5102х2; SM3017S ≈ SM-3017S ≈ DTSM3017S.
 */

/** Ключ сравнения: upper, без пробелов/дефисов, кириллическая «х» → latin x. */
export function normArticleKey(raw) {
  if (raw == null) return '';
  return String(raw)
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/[;,]+$/g, '')
    .replace(/[хХ]/g, 'x')
    .replace(/[\s\-_]+/g, '')
    .toUpperCase();
}

/** Варианты ключа с/без префикса DT (часто offer без DT, а card sku с DT и наоборот). */
export function articleKeyVariants(raw) {
  const base = normArticleKey(raw);
  if (!base) return [];
  const out = new Set([base]);
  if (base.startsWith('DT') && base.length > 2) out.add(base.slice(2));
  else out.add(`DT${base}`);
  return [...out];
}

export function articlesMatch(a, b) {
  const va = articleKeyVariants(a);
  const vb = new Set(articleKeyVariants(b));
  return va.some((k) => vb.has(k));
}

/** SQL-выражение нормализованного ключа артикула. */
export function sqlNormArticle(expr) {
  return `upper(replace(replace(translate(trim(both from COALESCE(${expr}, '')), 'хХ', 'xX'), '-', ''), ' ', ''))`;
}

/**
 * SQL-условие: два артикула совпадают с учётом дефисов/х/префикса DT.
 * @param {string} aExpr
 * @param {string} bExpr
 */
export function sqlArticlesMatch(aExpr, bExpr) {
  const a = sqlNormArticle(aExpr);
  const b = sqlNormArticle(bExpr);
  return `(
    (${a}) <> '' AND (${b}) <> '' AND (
      (${a}) = (${b})
      OR (${a}) = ('DT' || (${b}))
      OR (${b}) = ('DT' || (${a}))
    )
  )`;
}

/**
 * Индекс артикулов профиля → product_id (sku карточки + ERP sku, ±DT).
 * $1 = profile_id
 */
function sqlArticleIndexCte(alias = 'article_index') {
  const psKey = sqlNormArticle('ps.sku');
  const erpKey = sqlNormArticle('p.sku');
  return `
    ${alias} AS (
      SELECT product_id, norm_key FROM (
        SELECT ps.product_id, ${psKey} AS norm_key
        FROM product_skus ps
        JOIN products p ON p.id = ps.product_id AND p.profile_id = $1
        WHERE ps.marketplace = 'ozon' AND ${psKey} <> ''
        UNION
        SELECT p.id, ${erpKey}
        FROM products p
        WHERE p.profile_id = $1 AND ${erpKey} <> ''
      ) base
      WHERE norm_key <> ''
      UNION
      SELECT product_id,
             CASE WHEN norm_key LIKE 'DT%' AND length(norm_key) > 2
               THEN substr(norm_key, 3) ELSE ('DT' || norm_key) END
      FROM (
        SELECT ps.product_id, ${psKey} AS norm_key
        FROM product_skus ps
        JOIN products p ON p.id = ps.product_id AND p.profile_id = $1
        WHERE ps.marketplace = 'ozon' AND ${psKey} <> ''
        UNION
        SELECT p.id, ${erpKey}
        FROM products p
        WHERE p.profile_id = $1 AND ${erpKey} <> ''
      ) base2
      WHERE norm_key <> ''
    )`;
}

/**
 * SQL subquery: Ozon finance SKU → product_id via normalized offer_id.
 * $1 = profile_id
 */
export function sqlOzonOfferProductMapSubquery() {
  const offerKey = sqlNormArticle('o.offer_id');
  return `
    WITH ${sqlArticleIndexCte('article_index')}
    SELECT DISTINCT ON (TRIM(CAST(o.marketplace_sku AS TEXT)))
      TRIM(CAST(o.marketplace_sku AS TEXT)) AS mp_sku,
      ai.product_id
    FROM orders o
    JOIN article_index ai ON ai.norm_key = ${offerKey}
    WHERE o.profile_id = $1
      AND LOWER(o.marketplace) = 'ozon'
      AND o.marketplace_sku IS NOT NULL
      AND TRIM(CAST(o.marketplace_sku AS TEXT)) <> ''
      AND o.offer_id IS NOT NULL
      AND TRIM(o.offer_id) <> ''
      AND ${offerKey} <> ''
    ORDER BY TRIM(CAST(o.marketplace_sku AS TEXT)), ai.product_id
  `;
}

/** CTE wrapper for analytics / reporting queries ($1 = profile_id). */
export function sqlOzonSkuMapCte() {
  const offerKey = sqlNormArticle('o.offer_id');
  return `
  ${sqlArticleIndexCte('ozon_article_index')},
  ozon_sku_map AS (
    SELECT mp_sku, product_id
    FROM (
      (
        SELECT DISTINCT ON (TRIM(CAST(o.marketplace_sku AS TEXT)))
          TRIM(CAST(o.marketplace_sku AS TEXT)) AS mp_sku,
          ai.product_id
        FROM orders o
        JOIN ozon_article_index ai ON ai.norm_key = ${offerKey}
        WHERE o.profile_id = $1
          AND LOWER(o.marketplace) = 'ozon'
          AND o.marketplace_sku IS NOT NULL
          AND TRIM(CAST(o.marketplace_sku AS TEXT)) <> ''
          AND o.offer_id IS NOT NULL
          AND TRIM(o.offer_id) <> ''
          AND ${offerKey} <> ''
        ORDER BY TRIM(CAST(o.marketplace_sku AS TEXT)), ai.product_id
      )
      UNION ALL
      (
        -- product_skus.marketplace_product_id = Ozon product_id (не finance sku)
        SELECT DISTINCT ON (TRIM(CAST(ps.marketplace_product_id AS TEXT)))
          TRIM(CAST(ps.marketplace_product_id AS TEXT)) AS mp_sku,
          ps.product_id
        FROM product_skus ps
        JOIN products p ON p.id = ps.product_id AND p.profile_id = $1
        WHERE ps.marketplace = 'ozon'
          AND ps.marketplace_product_id IS NOT NULL
          AND TRIM(CAST(ps.marketplace_product_id AS TEXT)) <> ''
        ORDER BY TRIM(CAST(ps.marketplace_product_id AS TEXT)), ps.product_id
      )
      UNION ALL
      (
        -- mp_extra.ozon_sku = finance SKU из отчёта Ozon (items[].sku)
        SELECT DISTINCT ON (TRIM(ps.mp_extra->>'ozon_sku'))
          TRIM(ps.mp_extra->>'ozon_sku') AS mp_sku,
          ps.product_id
        FROM product_skus ps
        JOIN products p ON p.id = ps.product_id AND p.profile_id = $1
        WHERE ps.marketplace = 'ozon'
          AND ps.mp_extra ? 'ozon_sku'
          AND NULLIF(TRIM(ps.mp_extra->>'ozon_sku'), '') IS NOT NULL
        ORDER BY TRIM(ps.mp_extra->>'ozon_sku'), ps.product_id
      )
    ) u
  )`;
}
