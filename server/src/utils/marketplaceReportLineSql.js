/**
 * Общие SQL-фрагменты для аналитики по строкам финотчётов FBO/FBS
 * (marketplace_fbo_report_lines / marketplace_fbs_report_lines, алиас l)
 * и по снапшотам складов МП (marketplace_inventory_snapshot_lines, алиас l; снапшот s.norm_mp).
 *
 * Все фрагменты рассчитаны на $1 = profile_id.
 */

import { sqlNormArticle } from './offerArticleKey.js';

export const SALE_LINE = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND l.operation_type = 'Продажа')
  OR (LOWER(TRIM(l.marketplace)) = 'ozon' AND l.operation_type = 'OperationAgentDeliveredToCustomer')
  OR (LOWER(TRIM(l.marketplace)) IN ('ym', 'yandex', 'yandexmarket') AND (
    l.operation_type ILIKE '%Плат%покупателя%'
    OR l.operation_type ILIKE '%платеж покупателя%'
  ))
)`;

const rawNum = (key) => `CASE WHEN (l.raw_json->>'${key}') ~ '^-?[0-9]+(\\.[0-9]+)?$'
  THEN (l.raw_json->>'${key}')::numeric ELSE 0 END`;

export const SQL_IS_WB_LINE = `LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries')`;

/**
 * Возврат ранее учтённой продажи (товар вернулся, выручка и комиссия сторнируются).
 * Ozon ClientReturnAgentOperation с отрицательным accruals_for_sale — возврат после выкупа
 * (в строке сохранён как «логистика» на всю сумму сторно).
 */
export const RETURN_SALE_LINE = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND l.operation_type = 'Возврат')
  OR (LOWER(TRIM(l.marketplace)) = 'ozon' AND (
    l.operation_type = 'OperationAgentStornoDeliveredToCustomer'
    OR (l.operation_type = 'ClientReturnAgentOperation' AND ${rawNum('accruals_for_sale')} < 0)
  ))
)`;

/** Выручка сторнированной продажи: WB — retail_amount, Ozon — accruals_for_sale из raw_json. */
export const SQL_RETURNED_AMOUNT = `CASE WHEN ${SQL_IS_WB_LINE} THEN ABS(l.retail_amount)
  ELSE ABS(${rawNum('accruals_for_sale')}) END`;

/** Комиссия МП: по возврату продажи — со знаком минус (МП её возвращает). */
export const SQL_COMMISSION_SIGNED = `CASE WHEN ${RETURN_SALE_LINE}
  THEN -(CASE WHEN ${SQL_IS_WB_LINE} THEN ABS(l.commission_amount) ELSE ABS(${rawNum('sale_commission')}) END)
  ELSE l.commission_amount END`;

/** Логистика: у возврата продажи Ozon сумма сторно ошибочно лежит в logistics_amount — не считаем. */
export const SQL_LOGISTICS_FEE = `CASE WHEN ${RETURN_SALE_LINE} AND NOT ${SQL_IS_WB_LINE} THEN 0 ELSE l.logistics_amount END`;

/**
 * Фактически перечислено МП по строке.
 * WB: ppvz_for_pay (у возврата — со знаком минус) − логистика − хранение − штрафы − удержания,
 * т.к. WB удерживает их отдельно от «к перечислению». Ozon / ЯМ: payout_amount уже нетто со знаком.
 */
export const SQL_NET_TRANSFER = `CASE WHEN ${SQL_IS_WB_LINE}
  THEN (CASE WHEN l.operation_type = 'Возврат' THEN -ABS(l.payout_amount) ELSE l.payout_amount END)
       - l.logistics_amount - l.storage_amount - l.penalty_amount - l.other_deductions
  ELSE l.payout_amount END`;

export const SQL_MP_NORM = `CASE LOWER(TRIM(l.marketplace))
  WHEN 'wildberries' THEN 'wb'
  WHEN 'yandex' THEN 'ym'
  WHEN 'yandexmarket' THEN 'ym'
  ELSE LOWER(TRIM(l.marketplace))
END`;

export function sqlOzonNameMapCte() {
  const skuNorm = sqlNormArticle('p.sku');
  const nameNorm = sqlNormArticle('l.product_name');
  const coreSku = `CASE WHEN ${skuNorm} LIKE 'DT%' THEN substr(${skuNorm}, 3) ELSE ${skuNorm} END`;
  const alnumName = `lower(regexp_replace(COALESCE(l.product_name, ''), '[^a-zA-Zа-яА-ЯёЁ0-9]+', '', 'g'))`;
  const alnumProd = `lower(regexp_replace(COALESCE(p.name, ''), '[^a-zA-Zа-яА-ЯёЁ0-9]+', '', 'g'))`;
  return `
  ozon_name_map AS (
    SELECT mp_sku, product_id
    FROM (
      SELECT
        TRIM(l.sku) AS mp_sku,
        p.id AS product_id,
        COUNT(*) OVER (PARTITION BY TRIM(l.sku)) AS hit_cnt
      FROM (
        SELECT DISTINCT TRIM(sku) AS sku, MAX(product_name) AS product_name
        FROM (
          SELECT sku, product_name FROM marketplace_fbo_report_lines
          WHERE profile_id = $1 AND LOWER(TRIM(marketplace)) = 'ozon'
            AND product_id IS NULL
            AND sku IS NOT NULL AND TRIM(sku) <> '' AND TRIM(sku) <> '0'
            AND product_name IS NOT NULL AND TRIM(product_name) <> ''
          UNION ALL
          SELECT sku, product_name FROM marketplace_fbs_report_lines
          WHERE profile_id = $1 AND LOWER(TRIM(marketplace)) = 'ozon'
            AND product_id IS NULL
            AND sku IS NOT NULL AND TRIM(sku) <> '' AND TRIM(sku) <> '0'
            AND product_name IS NOT NULL AND TRIM(product_name) <> ''
        ) raw
        GROUP BY TRIM(sku)
      ) l
      JOIN products p ON p.profile_id = $1
      WHERE NOT EXISTS (SELECT 1 FROM ozon_sku_map m0 WHERE m0.mp_sku = TRIM(l.sku))
        AND (
          (
            ${coreSku} <> ''
            AND length(${coreSku}) >= 5
            AND ${coreSku} ~ '[A-Z]'
            AND ${coreSku} ~ '[0-9]'
            AND position(${coreSku} IN ${nameNorm}) > 0
          )
          OR (
            length(${alnumName}) >= 45
            AND left(${alnumProd}, 45) = left(${alnumName}, 45)
          )
        )
    ) ranked
    WHERE hit_cnt = 1
  )`;
}

/** JOIN строк отчёта на товар ERP: product_id → ozon_sku_map → ozon_name_map. Алиас товара — p. */
export function lineProductJoins() {
  return `
        LEFT JOIN ozon_sku_map m ON l.product_id IS NULL
          AND LOWER(TRIM(l.marketplace)) = 'ozon'
          AND l.sku IS NOT NULL
          AND TRIM(l.sku) <> ''
          AND TRIM(l.sku) <> '0'
          AND m.mp_sku = TRIM(l.sku)
        LEFT JOIN ozon_name_map nm ON l.product_id IS NULL
          AND m.product_id IS NULL
          AND LOWER(TRIM(l.marketplace)) = 'ozon'
          AND l.sku IS NOT NULL
          AND TRIM(l.sku) <> ''
          AND TRIM(l.sku) <> '0'
          AND nm.mp_sku = TRIM(l.sku)
        LEFT JOIN products p ON p.id = COALESCE(l.product_id, m.product_id, nm.product_id)`;
}

export const SQL_LINE_PRODUCT_ID = `COALESCE(l.product_id, m.product_id, nm.product_id)`;

export const SQL_EXCLUDE_JUNK = `
  AND NOT (
    l.product_id IS NULL
    AND m.product_id IS NULL
    AND nm.product_id IS NULL
    AND (l.sku IS NULL OR TRIM(l.sku) = '' OR TRIM(l.sku) = '0')
  )
`;

/** JOIN строки снапшота склада МП на товар ERP (s.norm_mp — нормализованный МП снапшота). */
export function skuJoinForSnapshot() {
  return `
    JOIN product_skus ps
      ON ps.marketplace = s.norm_mp
     AND (
       TRIM(ps.sku) = TRIM(l.external_sku)
       OR (
         s.norm_mp = 'ozon'
         AND NULLIF(ps.marketplace_product_id, 0) IS NOT NULL
         AND TRIM(l.external_sku) ~ '^[0-9]+$'
         AND ps.marketplace_product_id = (TRIM(l.external_sku))::bigint
       )
       OR (
         s.norm_mp = 'wb'
         AND (
           TRIM(ps.sku) = NULLIF(split_part(TRIM(l.external_sku), ':', 1), '')
           OR (
             NULLIF(split_part(TRIM(l.external_sku), ':', 2), '') IS NOT NULL
             AND TRIM(ps.sku) = NULLIF(split_part(TRIM(l.external_sku), ':', 2), '')
           )
           OR (
             NULLIF(TRIM(l.wb_vendor_code), '') IS NOT NULL
             AND LOWER(TRIM(ps.sku)) = LOWER(TRIM(l.wb_vendor_code))
           )
         )
       )
     )
    JOIN products p ON p.id = ps.product_id AND p.profile_id = $1`;
}

/** Нормализованный код МП снапшота (wb / ozon / ym). */
export const SQL_SNAPSHOT_MP_NORM = `CASE LOWER(TRIM(marketplace))
  WHEN 'wildberries' THEN 'wb'
  WHEN 'yandex' THEN 'ym'
  WHEN 'yandexmarket' THEN 'ym'
  ELSE LOWER(TRIM(marketplace))
END`;

/** Строки обоих отчётов (FBO + FBS) одним подзапросом с колонкой scheme. */
const REPORT_LINE_COLUMNS = [
  'id',
  'profile_id',
  'marketplace',
  'operation_date',
  'order_id',
  'posting_number',
  'sku',
  'product_name',
  'barcode',
  'product_id',
  'quantity',
  'retail_amount',
  'commission_amount',
  'logistics_amount',
  'storage_amount',
  'penalty_amount',
  'acquiring_amount',
  'other_deductions',
  'payout_amount',
  'operation_type',
  'raw_json',
];

/**
 * Строки обоих отчётов (FBO + FBS) одним подзапросом с колонкой scheme.
 * extraWhere — доп. условие на алиас r (например, по operation_date).
 */
export function sqlReportLinesUnion(scheme = 'all', extraWhere = '') {
  const cols = REPORT_LINE_COLUMNS.map((c) => `r.${c}`).join(', ');
  const parts = [];
  if (scheme === 'all' || scheme === 'fbo') {
    parts.push(
      `SELECT ${cols}, 'fbo'::text AS scheme FROM marketplace_fbo_report_lines r WHERE r.profile_id = $1 ${extraWhere}`
    );
  }
  if (scheme === 'all' || scheme === 'fbs') {
    parts.push(
      `SELECT ${cols}, 'fbs'::text AS scheme FROM marketplace_fbs_report_lines r WHERE r.profile_id = $1 ${extraWhere}`
    );
  }
  return `(${parts.join('\nUNION ALL\n')})`;
}
