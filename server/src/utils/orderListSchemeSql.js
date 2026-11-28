/**
 * SQL-предикаты схемы продаж для списка заказов и бейджей статусов.
 * Вынесено без зависимости от БД — те же правила в findAll и countGroupsBy*.
 */

export function applySalesSchemeSql(
  whereSql,
  params,
  paramIndex,
  { salesScheme, excludeSalesSchemes, fbsPipelineOnly } = {}
) {
  let sql = whereSql;
  const nextParams = params;
  let idx = paramIndex;

  if (salesScheme) {
    const scheme = String(salesScheme).trim().toLowerCase();
    if (scheme && scheme !== 'all') {
      if (scheme === 'fbs') {
        // FBS-пайплайн: явный fbs или схема ещё не размечена
        sql += ` AND (o.sales_scheme IS NULL OR LOWER(TRIM(o.sales_scheme)) = 'fbs')`;
      } else {
        sql += ` AND LOWER(TRIM(COALESCE(o.sales_scheme, ''))) = $${idx++}`;
        nextParams.push(scheme);
      }
    }
  }
  const excludeSchemes = Array.isArray(excludeSalesSchemes)
    ? excludeSalesSchemes.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  if (fbsPipelineOnly === true || excludeSchemes.length > 0) {
    const list =
      fbsPipelineOnly === true ? ['dbs', 'edbs', 'cnc', 'booking', ...(excludeSchemes || [])] : excludeSchemes;
    const uniq = [...new Set(list)];
    if (uniq.length > 0) {
      sql += ` AND (o.sales_scheme IS NULL OR LOWER(TRIM(o.sales_scheme)) <> ALL($${idx++}::text[]))`;
      nextParams.push(uniq);
    }
  }
  return { whereSql: sql, params: nextParams, paramIndex: idx };
}
