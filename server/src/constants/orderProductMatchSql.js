/**
 * SQL-сопоставление строки заказа (orders o) с товаром каталога.
 * WB: vendorCode в product_skus и products.mp_wb_vendor_code; nmId — в products.wb_draft.
 */

const WB_NM_ID_EXPR = (pAlias) => `TRIM(COALESCE(
  ${pAlias}.wb_draft::jsonb->>'nmId',
  ${pAlias}.wb_draft::jsonb->>'nmID',
  ${pAlias}.wb_draft::jsonb->>'nm_id',
  ''
))`;

/**
 * Совпадение по product_skus (псевдонимы ps, o).
 */
export function orderLineProductSkusMatchSql(psAlias = 'ps', orderAlias = 'o') {
  const ps = psAlias;
  const o = orderAlias;
  return `
    (${o}.offer_id IS NOT NULL AND TRIM(${ps}.sku) = TRIM(${o}.offer_id))
    OR (${o}.offer_id IS NOT NULL AND ${o}.marketplace = 'wb' AND LOWER(TRIM(${ps}.sku)) = LOWER(TRIM(${o}.offer_id)))
    OR (${o}.marketplace_sku IS NOT NULL AND TRIM(${ps}.sku) = TRIM(CAST(${o}.marketplace_sku AS TEXT)))
    OR (${o}.marketplace = 'ozon' AND ${o}.marketplace_sku IS NOT NULL AND ${ps}.marketplace_product_id IS NOT NULL
        AND ${ps}.marketplace_product_id = ${o}.marketplace_sku::bigint)
    OR (${o}.marketplace = 'wb' AND ${o}.offer_id IS NOT NULL
        AND TRIM(${ps}.sku) = TRIM(REGEXP_REPLACE(${o}.offer_id::text, '^.*?([0-9]+)$', '\\1')))
    OR (${o}.marketplace = 'wb' AND ${o}.product_name IS NOT NULL
        AND TRIM(${ps}.sku) = TRIM(REGEXP_REPLACE(${o}.product_name::text, '^.*?([0-9]+)$', '\\1')))
    OR (${o}.marketplace = 'wb' AND ${o}.marketplace_sku IS NOT NULL
        AND TRIM(CAST(${o}.marketplace_sku AS TEXT)) ~ '^[0-9]+$'
        AND TRIM(${ps}.sku) = TRIM(CAST(${o}.marketplace_sku AS TEXT)))
  `.trim();
}

/**
 * Совпадение по полям products (псевдонимы p, o) без product_skus.
 */
export function orderLineProductFieldsMatchSql(productAlias = 'p2', orderAlias = 'o') {
  const p = productAlias;
  const o = orderAlias;
  const nm = WB_NM_ID_EXPR(p);
  return `
    (${o}.offer_id IS NOT NULL AND TRIM(COALESCE(${p}.sku, '')) = TRIM(${o}.offer_id))
    OR (${o}.marketplace_sku IS NOT NULL AND TRIM(CAST(${o}.marketplace_sku AS TEXT)) = TRIM(COALESCE(${p}.sku, '')))
    OR (${o}.marketplace = 'wb' AND ${o}.offer_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(${p}.mp_wb_vendor_code, ''))) = LOWER(TRIM(${o}.offer_id)))
    OR (${o}.marketplace = 'wb' AND ${o}.marketplace_sku IS NOT NULL
        AND TRIM(CAST(${o}.marketplace_sku AS TEXT)) ~ '^[0-9]+$'
        AND ${nm} = TRIM(CAST(${o}.marketplace_sku AS TEXT)))
    OR (${o}.marketplace = 'wb' AND ${o}.offer_id IS NOT NULL AND TRIM(${o}.offer_id) ~ '^[0-9]+$'
        AND ${nm} = TRIM(${o}.offer_id))
    OR (${o}.marketplace = 'wb' AND ${o}.offer_id IS NOT NULL
        AND TRIM(COALESCE(${p}.sku, '')) = TRIM(REGEXP_REPLACE(${o}.offer_id::text, '^.*?([0-9]+)$', '\\1')))
    OR (${o}.marketplace = 'wb' AND ${o}.product_name IS NOT NULL
        AND TRIM(COALESCE(${p}.sku, '')) = TRIM(REGEXP_REPLACE(${o}.product_name::text, '^.*?([0-9]+)$', '\\1')))
  `.trim();
}

/** Условие: строка заказа o относится к товару каталога с id = $1 (для WHERE/EXISTS). */
export function orderLineMatchesCatalogProductIdSql() {
  const skuMatch = orderLineProductSkusMatchSql('ps', 'o');
  const productFieldsMatch = orderLineProductFieldsMatchSql('pmain', 'o');
  return `
        (
          o.product_id = $1
          OR EXISTS (
            SELECT 1 FROM product_skus ps
            WHERE ps.product_id = $1
              AND ps.marketplace = o.marketplace
              AND (${skuMatch})
          )
          OR EXISTS (
            SELECT 1 FROM products pmain
            WHERE pmain.id = $1
              AND (
                (${productFieldsMatch})
                OR (o.marketplace = 'ozon' AND o.marketplace_sku IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM product_skus x
                    WHERE x.product_id = pmain.id AND x.marketplace = 'ozon'
                      AND x.marketplace_product_id IS NOT NULL
                      AND x.marketplace_product_id = o.marketplace_sku::bigint
                  ))
              )
          )
          OR EXISTS (
            SELECT 1 FROM product_skus psku
            WHERE psku.product_id = $1
              AND (${orderLineProductSkusMatchSql('psku', 'o')})
          )
          OR EXISTS (
            SELECT 1 FROM kit_components kc
            WHERE kc.component_product_id = $1
              AND (
                (o.product_id IS NOT NULL AND kc.kit_product_id = o.product_id)
                OR o.product_id = kc.component_product_id
                OR EXISTS (
                  SELECT 1 FROM product_skus ps
                  WHERE ps.product_id = kc.kit_product_id
                    AND ps.marketplace = o.marketplace
                    AND (${skuMatch})
                )
                OR EXISTS (
                  SELECT 1 FROM products pk
                  WHERE pk.id = kc.kit_product_id
                    AND (${orderLineProductFieldsMatchSql('pk', 'o')})
                )
              )
          )
        )`.trim();
}

/** LATERAL-подзапрос: matched_product_* для списка/карточки заказа. */
export const ORDER_PRODUCT_LATERAL_SUBQUERY_SQL = `
  SELECT p2.name AS matched_product_name, p2.sku AS matched_product_sku, p2.id AS matched_product_id
  FROM products p2
  LEFT JOIN product_skus ps ON ps.product_id = p2.id AND ps.marketplace = o.marketplace
  WHERE (ps.id IS NOT NULL AND (${orderLineProductSkusMatchSql('ps', 'o')}))
     OR (${orderLineProductFieldsMatchSql('p2', 'o')})
  LIMIT 1
`;
