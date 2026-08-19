/**
 * Поиск факта по одному заказу/отправлению в таблицах финансовых отчётов.
 */

import { query } from '../config/database.js';
import { buildOrderBreakdownFromLines, buildAmountTooltips } from './marketplaceReportBreakdown.js';
import {
  enrichAnalyticsRowWithTax,
  loadMarketplaceTaxContext,
} from './marketplaceOrderTax.js';
import {
  attachOrderEconomics,
  backfillReportOrderIds,
  marketplaceFilterValues,
  orderLookupKeys,
} from './marketplaceOrderEconomics.js';

const TABLES = {
  fbs: 'marketplace_fbs_report_lines',
  fbo: 'marketplace_fbo_report_lines',
};

const SQL_SALE_LINE = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND l.operation_type = 'Продажа')
  OR (LOWER(TRIM(l.marketplace)) = 'ozon' AND l.operation_type = 'OperationAgentDeliveredToCustomer')
  OR (LOWER(TRIM(l.marketplace)) IN ('ym', 'yandex', 'yandexmarket') AND (
    l.operation_type ILIKE '%Плат%покупателя%'
    OR l.operation_type ILIKE '%платеж покупателя%'
  ))
)`;

function formatPgDateYmd(value) {
  if (value == null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function normMpForDb(mp) {
  const m = String(mp || '').toLowerCase();
  if (m === 'wildberries') return 'wb';
  if (m === 'yandex' || m === 'yandexmarket') return 'ym';
  return m;
}

function mapLookupRow(row, taxContext) {
  const reportLines = Array.isArray(row.report_lines_json) ? row.report_lines_json : [];
  const breakdown = buildOrderBreakdownFromLines(reportLines);
  const amountTooltips = buildAmountTooltips(breakdown);
  const base = {
    marketplace: normMpForDb(row.marketplace),
    operationDate: formatPgDateYmd(row.operation_date),
    orderId: row.order_id,
    postingNumber: row.posting_number,
    sku: row.sku,
    productId: Number(row.product_id) || null,
    erpSku: row.erp_sku || null,
    productName: row.product_name,
    quantity: Number(row.quantity) || 0,
    retailAmount: Number(row.retail_amount) || 0,
    commissionAmount: Number(row.commission_amount) || 0,
    logisticsAmount: Number(row.logistics_amount) || 0,
    storageAmount: Number(row.storage_amount) || 0,
    penaltyAmount: Number(row.penalty_amount) || 0,
    acquiringAmount: Number(row.acquiring_amount) || 0,
    otherDeductions: Number(row.other_deductions) || 0,
    payoutAmount: Number(row.payout_amount) || 0,
    costAmount: Number(row.cost_amount) || 0,
    additionalExpensesAmount: Number(row.additional_expenses_amount) || 0,
    lineCount: Number(row.line_count) || 0,
    breakdown,
    amountTooltips,
    expensesTotal:
      Number(row.commission_amount) +
        Number(row.logistics_amount) +
        Number(row.storage_amount) +
        Number(row.penalty_amount) +
        Number(row.acquiring_amount) +
        Number(row.other_deductions) || 0,
  };
  return attachOrderEconomics(enrichAnalyticsRowWithTax(base, taxContext));
}

/**
 * @param {'fbs'|'fbo'} scheme
 */
export async function lookupMarketplaceOrderEconomics(
  scheme,
  { profileId, marketplace, orderId } = {}
) {
  const table = TABLES[scheme];
  if (!table) {
    const err = new Error('Неизвестная схема (fbs/fbo)');
    err.statusCode = 400;
    throw err;
  }
  const pid = profileId != null ? Number(profileId) : null;
  if (!Number.isFinite(pid) || pid < 1) {
    const err = new Error('Профиль не определён');
    err.statusCode = 403;
    throw err;
  }
  const keys = orderLookupKeys(orderId);
  if (!keys.length) {
    const err = new Error('Не указан номер заказа');
    err.statusCode = 400;
    throw err;
  }
  const mpFilter = marketplaceFilterValues(marketplace);
  if (!mpFilter) {
    const err = new Error('Укажите маркетплейс');
    err.statusCode = 400;
    throw err;
  }

  await backfillReportOrderIds(table, pid);

  const sql = `
    SELECT
      MAX(l.marketplace) AS marketplace,
      COALESCE(
        MAX(l.operation_date) FILTER (WHERE ${SQL_SALE_LINE}),
        MAX(l.operation_date)
      ) AS operation_date,
      MAX(l.order_id) FILTER (WHERE NULLIF(TRIM(l.order_id), '') IS NOT NULL) AS order_id,
      MAX(l.posting_number) FILTER (
        WHERE NULLIF(TRIM(l.posting_number), '') IS NOT NULL AND TRIM(l.posting_number) <> '0'
      ) AS posting_number,
      MAX(l.product_id) AS product_id,
      MAX(NULLIF(TRIM(l.sku), '')) AS sku,
      MAX(COALESCE(p.name, NULLIF(TRIM(l.product_name), ''))) AS product_name,
      MAX(p.sku) AS erp_sku,
      SUM(CASE WHEN ${SQL_SALE_LINE} THEN GREATEST(l.quantity, 0) ELSE 0 END)::int AS quantity,
      SUM(l.retail_amount)::numeric AS retail_amount,
      SUM(l.commission_amount)::numeric AS commission_amount,
      SUM(l.logistics_amount)::numeric AS logistics_amount,
      SUM(l.storage_amount)::numeric AS storage_amount,
      SUM(l.penalty_amount)::numeric AS penalty_amount,
      SUM(l.acquiring_amount)::numeric AS acquiring_amount,
      SUM(l.other_deductions)::numeric AS other_deductions,
      SUM(l.payout_amount)::numeric AS payout_amount,
      SUM(
        CASE WHEN ${SQL_SALE_LINE}
          THEN GREATEST(l.quantity, 0) * COALESCE(p.cost, 0)
          ELSE 0
        END
      )::numeric AS cost_amount,
      SUM(
        CASE WHEN ${SQL_SALE_LINE}
          THEN GREATEST(l.quantity, 0) * COALESCE(p.additional_expenses, 0)
          ELSE 0
        END
      )::numeric AS additional_expenses_amount,
      COUNT(*)::int AS line_count,
      COALESCE(
        json_agg(
          json_build_object(
            'marketplace', l.marketplace,
            'operation_type', l.operation_type,
            'retail_amount', l.retail_amount,
            'commission_amount', l.commission_amount,
            'logistics_amount', l.logistics_amount,
            'storage_amount', l.storage_amount,
            'penalty_amount', l.penalty_amount,
            'acquiring_amount', l.acquiring_amount,
            'other_deductions', l.other_deductions,
            'raw_json', l.raw_json
          )
          ORDER BY l.id
        ) FILTER (WHERE l.id IS NOT NULL),
        '[]'::json
      ) AS report_lines_json
    FROM ${table} l
    LEFT JOIN products p ON p.id = l.product_id
    WHERE l.profile_id = $1
      AND LOWER(TRIM(l.marketplace)) = ANY($2::text[])
      AND (
        NULLIF(TRIM(l.order_id), '') = ANY($3::text[])
        OR (
          NULLIF(TRIM(l.posting_number), '') IS NOT NULL
          AND TRIM(l.posting_number) <> '0'
          AND TRIM(l.posting_number) = ANY($3::text[])
        )
        OR NULLIF(TRIM(l.raw_json->>'assembly_id'), '') = ANY($3::text[])
        OR NULLIF(TRIM(l.raw_json->>'assemblyId'), '') = ANY($3::text[])
        OR NULLIF(TRIM(l.raw_json->>'srid'), '') = ANY($3::text[])
        OR NULLIF(TRIM(l.raw_json->>'rid'), '') = ANY($3::text[])
        OR NULLIF(TRIM(l.raw_json->>'gNumber'), '') = ANY($3::text[])
      )
  `;

  const res = await query(sql, [pid, mpFilter, keys]);
  const row = res.rows?.[0];
  if (!row || Number(row.line_count) < 1) {
    return { found: false, item: null };
  }
  const taxContext = await loadMarketplaceTaxContext(pid);
  return { found: true, item: mapLookupRow(row, taxContext) };
}
