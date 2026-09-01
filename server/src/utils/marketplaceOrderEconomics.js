/**
 * Факт по заказу из финансового отчёта МП:
 * цена продажи, затраты (удержания МП), сколько пришло.
 * Себестоимость и доп. расходы считаются отдельно, в «Итого затрат» не входят.
 */

import { query } from '../config/database.js';

export function mpFeesTotal(row) {
  return (
    (Number(row.commissionAmount ?? row.commission_amount) || 0) +
    (Number(row.logisticsAmount ?? row.logistics_amount) || 0) +
    (Number(row.storageAmount ?? row.storage_amount) || 0) +
    (Number(row.penaltyAmount ?? row.penalty_amount) || 0) +
    (Number(row.acquiringAmount ?? row.acquiring_amount) || 0) +
    (Number(row.otherDeductions ?? row.other_deductions) || 0)
  );
}

export function additionalExpensesFromRow(row) {
  return Number(row?.additionalExpensesAmount ?? row?.additional_expenses_amount) || 0;
}

export function isWbMarketplace(mp) {
  const v = String(mp || '').toLowerCase();
  return v === 'wb' || v === 'wildberries';
}

/** Числовой assembly_id / номер сборочного задания WB. */
export function isWbNumericOrderId(orderId) {
  return /^[0-9]+$/.test(String(orderId || '').trim());
}

/** srid/rid и прочие нечисловые ключи отгрузки WB. */
export function isWbSridOrderId(orderId) {
  const s = String(orderId || '').trim();
  return s.length > 0 && !isWbNumericOrderId(s);
}

/**
 * Выручка: пришло от МП − себестоимость − доп. расходы.
 * У WB дополнительно − логистика (в payout она не вычтена).
 */
export function marketplaceRevenueAmount(row) {
  const received = Number(row?.receivedAmount ?? row?.payoutAmount ?? row?.payout_amount) || 0;
  const costAmount = Number(row?.costAmount ?? row?.cost_amount) || 0;
  const additionalExpensesAmount = additionalExpensesFromRow(row);
  const wbLogistics =
    Number(row?.wbLogisticsAmount ?? row?.wb_logistics_amount) ||
    (isWbMarketplace(row?.marketplace) ? Number(row?.logisticsAmount ?? row?.logistics_amount) || 0 : 0);
  return received - costAmount - additionalExpensesAmount - wbLogistics;
}

/** Добавляет saleAmount / costsTotal / receivedAmount к строке аналитики. */
export function attachOrderEconomics(row) {
  const additionalExpensesAmount = additionalExpensesFromRow(row);
  const expensesTotal = Number(row.expensesTotal) || mpFeesTotal(row);
  const receivedAmount = Number(row.payoutAmount) || 0;
  const withAmounts = {
    ...row,
    expensesTotal,
    additionalExpensesAmount,
    saleAmount: Number(row.retailAmount) || 0,
    costsTotal: expensesTotal,
    receivedAmount,
  };
  return {
    ...withAmounts,
    revenueAmount: marketplaceRevenueAmount(withAmounts),
  };
}

/**
 * Варианты ID заказа для поиска в строках отчёта (Ozon ~n, YM :sku).
 */
export function orderLookupKeys(orderId) {
  const raw = String(orderId || '').trim();
  const keys = new Set();
  if (!raw) return [];
  keys.add(raw);
  const tilde = raw.indexOf('~');
  if (tilde > 0) keys.add(raw.slice(0, tilde).trim());
  const colon = raw.indexOf(':');
  if (colon > 0) keys.add(raw.slice(0, colon).trim());
  return [...keys].filter(Boolean);
}

export function marketplaceFilterValues(marketplace) {
  const v = String(marketplace || '').trim().toLowerCase();
  if (!v || v === 'all') return null;
  if (v === 'ozon') return ['ozon'];
  if (v === 'wb' || v === 'wildberries') return ['wb', 'wildberries'];
  if (v === 'ym' || v === 'yandex' || v === 'yandexmarket') return ['ym', 'yandex', 'yandexmarket'];
  return [v];
}

/**
 * WB: в ERP номер заказа = assembly_id, в старых строках отчёта в order_id лежит srid.
 * Ozon: в order_id часто пусто, номер отправления только в posting_number.
 */
export async function backfillReportOrderIds(table, profileId) {
  const allowed = new Set(['marketplace_fbs_report_lines', 'marketplace_fbo_report_lines']);
  if (!allowed.has(table)) return;
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return;

  await query(
    `UPDATE ${table}
     SET
       order_id = CASE
         WHEN NULLIF(TRIM(COALESCE(raw_json->>'assembly_id', raw_json->>'assemblyId', '')), '') IS NOT NULL
           AND TRIM(COALESCE(raw_json->>'assembly_id', raw_json->>'assemblyId', '')) <> '0'
         THEN TRIM(COALESCE(raw_json->>'assembly_id', raw_json->>'assemblyId'))
         ELSE order_id
       END,
       posting_number = CASE
         WHEN NULLIF(TRIM(COALESCE(raw_json->>'srid', raw_json->>'rid', '')), '') IS NOT NULL
         THEN TRIM(COALESCE(raw_json->>'srid', raw_json->>'rid'))
         ELSE posting_number
       END
     WHERE profile_id = $1
       AND LOWER(TRIM(marketplace)) IN ('wb', 'wildberries')`,
    [pid]
  );

  await query(
    `UPDATE ${table}
     SET order_id = TRIM(posting_number)
     WHERE profile_id = $1
       AND LOWER(TRIM(marketplace)) = 'ozon'
       AND (order_id IS NULL OR TRIM(order_id) = '')
       AND NULLIF(TRIM(posting_number), '') IS NOT NULL
       AND TRIM(posting_number) <> '0'`,
    [pid]
  );

  await backfillWbOrderIdsFromSales(table, pid);
}

/**
 * WB: логистика/возмещения без assembly_id хранят srid в order_id.
 * Подставляем числовой order_id из строки «Продажа» по posting_number / barcode / shk_id.
 */
export async function backfillWbOrderIdsFromSales(table, profileId) {
  const allowed = new Set(['marketplace_fbs_report_lines', 'marketplace_fbo_report_lines']);
  if (!allowed.has(table)) return;
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return;

  const saleSubquery = `
    SELECT DISTINCT ON (link_key)
      link_key,
      order_id
    FROM (
      SELECT TRIM(posting_number) AS link_key, TRIM(order_id) AS order_id, id
      FROM ${table}
      WHERE profile_id = $1
        AND LOWER(TRIM(marketplace)) IN ('wb', 'wildberries')
        AND operation_type = 'Продажа'
        AND order_id IS NOT NULL AND TRIM(order_id) ~ '^[0-9]+$'
        AND posting_number IS NOT NULL AND TRIM(posting_number) <> ''
      UNION ALL
      SELECT TRIM(barcode) AS link_key, TRIM(order_id) AS order_id, id
      FROM ${table}
      WHERE profile_id = $1
        AND LOWER(TRIM(marketplace)) IN ('wb', 'wildberries')
        AND operation_type = 'Продажа'
        AND order_id IS NOT NULL AND TRIM(order_id) ~ '^[0-9]+$'
        AND barcode IS NOT NULL AND TRIM(barcode) <> ''
      UNION ALL
      SELECT TRIM(COALESCE(raw_json->>'shk_id', '')) AS link_key, TRIM(order_id) AS order_id, id
      FROM ${table}
      WHERE profile_id = $1
        AND LOWER(TRIM(marketplace)) IN ('wb', 'wildberries')
        AND operation_type = 'Продажа'
        AND order_id IS NOT NULL AND TRIM(order_id) ~ '^[0-9]+$'
        AND NULLIF(TRIM(COALESCE(raw_json->>'shk_id', '')), '') IS NOT NULL
    ) src
    WHERE link_key IS NOT NULL AND link_key <> ''
    ORDER BY link_key, id DESC`;

  const orphanWhere = `
    orphan.profile_id = $1
    AND LOWER(TRIM(orphan.marketplace)) IN ('wb', 'wildberries')
    AND orphan.operation_type <> 'Продажа'
    AND (
      orphan.order_id IS NULL OR TRIM(orphan.order_id) = '' OR TRIM(orphan.order_id) !~ '^[0-9]+$'
    )`;

  await query(
    `UPDATE ${table} orphan
     SET order_id = src.order_id
     FROM (${saleSubquery}) src
     WHERE ${orphanWhere}
       AND orphan.posting_number IS NOT NULL
       AND TRIM(orphan.posting_number) <> ''
       AND src.link_key = TRIM(orphan.posting_number)`,
    [pid]
  );

  await query(
    `UPDATE ${table} orphan
     SET order_id = src.order_id
     FROM (${saleSubquery}) src
     WHERE ${orphanWhere}
       AND orphan.barcode IS NOT NULL
       AND TRIM(orphan.barcode) <> ''
       AND src.link_key = TRIM(orphan.barcode)`,
    [pid]
  );

  await query(
    `UPDATE ${table} orphan
     SET order_id = src.order_id
     FROM (${saleSubquery}) src
     WHERE ${orphanWhere}
       AND NULLIF(TRIM(COALESCE(orphan.raw_json->>'shk_id', '')), '') IS NOT NULL
       AND src.link_key = TRIM(COALESCE(orphan.raw_json->>'shk_id', ''))`,
    [pid]
  );
}
