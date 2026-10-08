/**
 * Товар ERP для строки заказа: у заказов до середины 2026 product_id не заполнен,
 * поэтому подбираем товар по (маркетплейс, offer_id) через product_skus.
 * Фрагменты рассчитаны на $1 = profile_id.
 */

const SQL_ORDER_MP = (alias) => `CASE LOWER(TRIM(${alias}.marketplace))
  WHEN 'wildberries' THEN 'wb' WHEN 'yandex' THEN 'ym' WHEN 'yandexmarket' THEN 'ym'
  ELSE LOWER(TRIM(${alias}.marketplace)) END`;

/** CTE order_offer_map (добавлять в WITH). */
export function sqlOrderOfferMapCte() {
  return `order_offer_map AS (
    SELECT DISTINCT ON (ps.marketplace, TRIM(ps.sku)) ps.marketplace, TRIM(ps.sku) AS offer, ps.product_id
      FROM product_skus ps
      JOIN products pp ON pp.id = ps.product_id AND pp.profile_id = $1
     WHERE ps.sku IS NOT NULL AND TRIM(ps.sku) <> ''
     ORDER BY ps.marketplace, TRIM(ps.sku), ps.product_id
  )`;
}

/** LEFT JOIN на order_offer_map (алиас oom). */
export function sqlOrderOfferJoin(alias = 'o') {
  return `LEFT JOIN order_offer_map oom
    ON ${alias}.product_id IS NULL
   AND oom.marketplace = ${SQL_ORDER_MP(alias)}
   AND oom.offer = TRIM(${alias}.offer_id)`;
}

export function sqlOrderProductId(alias = 'o') {
  return `COALESCE(${alias}.product_id, oom.product_id)`;
}
