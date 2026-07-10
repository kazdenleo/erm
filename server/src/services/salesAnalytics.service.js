/**
 * Аналитика продаж FBS по товарам (заказы + возвраты от клиентов на склад).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';

const FBS_MARKETPLACES = ['ozon', 'wb', 'wildberries', 'ym', 'yandex', 'yandexmarket'];

function normalizeMarketplaceFilter(raw) {
  const v = String(raw || 'all').trim().toLowerCase();
  if (!v || v === 'all') return null;
  if (v === 'ozon') return ['ozon'];
  if (v === 'wb' || v === 'wildberries') return ['wb', 'wildberries'];
  if (v === 'ym' || v === 'yandex' || v === 'yandexmarket') return ['ym', 'yandex', 'yandexmarket'];
  return [v];
}

function parseDateYmd(raw, fallback) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

function toExclusiveEnd(dateToYmd) {
  const [y, mo, d] = dateToYmd.split('-').map((x) => parseInt(x, 10));
  const end = new Date(Date.UTC(y, mo - 1, d + 1, 0, 0, 0));
  return end.toISOString();
}

function toInclusiveStart(dateFromYmd) {
  const [y, mo, d] = dateFromYmd.split('-').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0)).toISOString();
}

class SalesAnalyticsService {
  /**
   * Аналитика FBS по товарам: продано, отменено, возвращено на склад.
   */
  async getFbsByProduct({
    profileId,
    dateFrom = null,
    dateTo = null,
    marketplace = 'all',
    limit = 500,
  } = {}) {
    const pid = profileId != null ? Number(profileId) : null;
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Доступно только с PostgreSQL');
      err.statusCode = 501;
      throw err;
    }

    const defaults = defaultDateRange();
    const fromYmd = parseDateYmd(dateFrom, defaults.dateFrom);
    const toYmd = parseDateYmd(dateTo, defaults.dateTo);
    const startIso = toInclusiveStart(fromYmd);
    const endIso = toExclusiveEnd(toYmd);
    const mpFilter = normalizeMarketplaceFilter(marketplace);
    const rowLimit = Math.min(1000, Math.max(1, parseInt(limit, 10) || 500));

    const itemsSql = `
      WITH order_stats AS (
        SELECT
          o.product_id,
          SUM(CASE WHEN LOWER(TRIM(o.status)) = 'delivered' THEN GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::int AS sold_qty,
          SUM(CASE WHEN LOWER(TRIM(o.status)) = 'delivered'
            THEN COALESCE(o.price, 0) * GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::numeric AS sold_amount,
          SUM(CASE WHEN LOWER(TRIM(o.status)) IN ('cancelled', 'canceled')
            THEN GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::int AS canceled_qty,
          SUM(CASE WHEN LOWER(TRIM(o.status)) IN ('cancelled', 'canceled')
            THEN COALESCE(o.price, 0) * GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::numeric AS canceled_amount
        FROM orders o
        WHERE o.profile_id = $1
          AND o.product_id IS NOT NULL
          AND LOWER(TRIM(COALESCE(o.marketplace, ''))) = ANY($5::text[])
          ${mpFilter ? 'AND LOWER(TRIM(o.marketplace)) = ANY($6::text[])' : ''}
          AND (
            (
              LOWER(TRIM(o.status)) = 'delivered'
              AND COALESCE(o.terminal_status_at, o.created_at) >= $2::timestamptz
              AND COALESCE(o.terminal_status_at, o.created_at) < $3::timestamptz
            )
            OR (
              LOWER(TRIM(o.status)) IN ('cancelled', 'canceled')
              AND COALESCE(o.terminal_status_at, o.created_at) >= $2::timestamptz
              AND COALESCE(o.terminal_status_at, o.created_at) < $3::timestamptz
            )
          )
        GROUP BY o.product_id
      ),
      return_stats AS (
        SELECT
          wrl.product_id,
          SUM(GREATEST(wrl.quantity, 0))::int AS returned_qty
        FROM warehouse_receipt_lines wrl
        INNER JOIN warehouse_receipts wr ON wr.id = wrl.receipt_id
        INNER JOIN products p ON p.id = wrl.product_id
        WHERE wr.document_type = 'customer_return'
          AND p.profile_id = $1
          AND wr.created_at >= $2::timestamptz
          AND wr.created_at < $3::timestamptz
        GROUP BY wrl.product_id
      )
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.sku AS product_sku,
        COALESCE(os.sold_qty, 0)::int AS sold_qty,
        COALESCE(os.sold_amount, 0)::numeric AS sold_amount,
        COALESCE(os.canceled_qty, 0)::int AS canceled_qty,
        COALESCE(os.canceled_amount, 0)::numeric AS canceled_amount,
        COALESCE(rs.returned_qty, 0)::int AS returned_qty
      FROM products p
      LEFT JOIN order_stats os ON os.product_id = p.id
      LEFT JOIN return_stats rs ON rs.product_id = p.id
      WHERE p.profile_id = $1
        AND (
          COALESCE(os.sold_qty, 0) > 0
          OR COALESCE(os.canceled_qty, 0) > 0
          OR COALESCE(rs.returned_qty, 0) > 0
        )
      ORDER BY COALESCE(os.sold_qty, 0) DESC, COALESCE(rs.returned_qty, 0) DESC, p.name ASC
      LIMIT $4
    `;

    const itemsParams = mpFilter
      ? [pid, startIso, endIso, rowLimit, FBS_MARKETPLACES, mpFilter]
      : [pid, startIso, endIso, rowLimit, FBS_MARKETPLACES];

    const summarySql = `
      WITH order_stats AS (
        SELECT
          SUM(CASE WHEN LOWER(TRIM(o.status)) = 'delivered' THEN GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::int AS sold_qty,
          SUM(CASE WHEN LOWER(TRIM(o.status)) = 'delivered'
            THEN COALESCE(o.price, 0) * GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::numeric AS sold_amount,
          SUM(CASE WHEN LOWER(TRIM(o.status)) IN ('cancelled', 'canceled')
            THEN GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::int AS canceled_qty,
          SUM(CASE WHEN LOWER(TRIM(o.status)) IN ('cancelled', 'canceled')
            THEN COALESCE(o.price, 0) * GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::numeric AS canceled_amount
        FROM orders o
        WHERE o.profile_id = $1
          AND o.product_id IS NOT NULL
          AND LOWER(TRIM(COALESCE(o.marketplace, ''))) = ANY($4::text[])
          ${mpFilter ? 'AND LOWER(TRIM(o.marketplace)) = ANY($5::text[])' : ''}
          AND (
            (
              LOWER(TRIM(o.status)) = 'delivered'
              AND COALESCE(o.terminal_status_at, o.created_at) >= $2::timestamptz
              AND COALESCE(o.terminal_status_at, o.created_at) < $3::timestamptz
            )
            OR (
              LOWER(TRIM(o.status)) IN ('cancelled', 'canceled')
              AND COALESCE(o.terminal_status_at, o.created_at) >= $2::timestamptz
              AND COALESCE(o.terminal_status_at, o.created_at) < $3::timestamptz
            )
          )
      ),
      return_stats AS (
        SELECT SUM(GREATEST(wrl.quantity, 0))::int AS returned_qty
        FROM warehouse_receipt_lines wrl
        INNER JOIN warehouse_receipts wr ON wr.id = wrl.receipt_id
        INNER JOIN products p ON p.id = wrl.product_id
        WHERE wr.document_type = 'customer_return'
          AND p.profile_id = $1
          AND wr.created_at >= $2::timestamptz
          AND wr.created_at < $3::timestamptz
      )
      SELECT
        COALESCE((SELECT sold_qty FROM order_stats), 0)::int AS sold_qty,
        COALESCE((SELECT sold_amount FROM order_stats), 0)::numeric AS sold_amount,
        COALESCE((SELECT canceled_qty FROM order_stats), 0)::int AS canceled_qty,
        COALESCE((SELECT canceled_amount FROM order_stats), 0)::numeric AS canceled_amount,
        COALESCE((SELECT returned_qty FROM return_stats), 0)::int AS returned_qty
    `;

    const summaryParams = mpFilter
      ? [pid, startIso, endIso, FBS_MARKETPLACES, mpFilter]
      : [pid, startIso, endIso, FBS_MARKETPLACES];

    const [itemsRes, summaryRes] = await Promise.all([
      query(itemsSql, itemsParams),
      query(summarySql, summaryParams),
    ]);

    const summaryRow = summaryRes.rows?.[0] || {};
    const items = (itemsRes.rows || []).map((row) => ({
      productId: Number(row.product_id),
      productName: row.product_name || '',
      productSku: row.product_sku || '',
      soldQty: Number(row.sold_qty) || 0,
      soldAmount: Number(row.sold_amount) || 0,
      canceledQty: Number(row.canceled_qty) || 0,
      canceledAmount: Number(row.canceled_amount) || 0,
      returnedQty: Number(row.returned_qty) || 0,
    }));

    return {
      period: { dateFrom: fromYmd, dateTo: toYmd },
      marketplace: mpFilter ? marketplace : 'all',
      summary: {
        soldQty: Number(summaryRow.sold_qty) || 0,
        soldAmount: Number(summaryRow.sold_amount) || 0,
        canceledQty: Number(summaryRow.canceled_qty) || 0,
        canceledAmount: Number(summaryRow.canceled_amount) || 0,
        returnedQty: Number(summaryRow.returned_qty) || 0,
      },
      items,
    };
  }
}

export default new SalesAnalyticsService();
