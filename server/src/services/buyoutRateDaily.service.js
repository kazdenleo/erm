/**
 * Суточный пересчёт % выкупа:
 * FBS — терминальные заказы (delivered vs cancelled),
 * FBO — финансовые отчёты (продажа vs возврат).
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import { computeBuyoutPercent } from '../utils/marketplaceBuyoutRate.js';

const FBO_SALE = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND l.operation_type = 'Продажа')
  OR (LOWER(TRIM(l.marketplace)) = 'ozon' AND l.operation_type = 'OperationAgentDeliveredToCustomer')
  OR (LOWER(TRIM(l.marketplace)) IN ('ym', 'yandex', 'yandexmarket') AND (
    l.operation_type ILIKE '%Плат%покупателя%'
    OR l.operation_type ILIKE '%платеж покупателя%'
  ))
)`;

const FBO_RETURN = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND (
    l.operation_type = 'Возврат' OR LOWER(l.operation_type) LIKE '%возврат%'
  ))
  OR (LOWER(TRIM(l.marketplace)) = 'ozon' AND (
    LOWER(l.operation_type) LIKE '%return%'
    OR LOWER(l.operation_type) LIKE '%stornodelivered%'
  ))
  OR (LOWER(TRIM(l.marketplace)) IN ('ym', 'yandex', 'yandexmarket') AND (
    l.operation_type ILIKE '%возврат%'
    OR l.operation_type ILIKE '%невыкуп%'
    OR l.operation_type ILIKE '%refund%'
  ))
)`;

function windowDays() {
  const n = Number(process.env.BUYOUT_RATE_WINDOW_DAYS);
  return Number.isFinite(n) && n >= 7 && n <= 180 ? Math.round(n) : 30;
}

function minUnits() {
  const n = Number(process.env.BUYOUT_RATE_MIN_UNITS);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 3;
}

function normMp(raw) {
  const m = String(raw || '').toLowerCase().trim();
  if (m === 'wb' || m === 'wildberries') return 'wb';
  if (m === 'ym' || m === 'yandex' || m === 'yandexmarket') return 'ym';
  if (m === 'ozon') return 'ozon';
  return null;
}

function emptyAcc() {
  return { delivered: 0, returned: 0 };
}

function addQty(map, productId, mp, field, qty) {
  const pid = Number(productId);
  const marketplace = normMp(mp);
  const n = Math.max(0, Number(qty) || 0);
  if (!Number.isFinite(pid) || pid < 1 || !marketplace || n <= 0) return;
  const key = `${pid}:${marketplace}`;
  if (!map.has(key)) map.set(key, { productId: pid, marketplace, ...emptyAcc() });
  map.get(key)[field] += n;
}

async function loadFbsTerminals(profileId, days) {
  const r = await query(
    `SELECT
       o.product_id,
       LOWER(TRIM(o.marketplace)) AS marketplace,
       SUM(CASE WHEN LOWER(TRIM(o.status)) = 'delivered'
         THEN GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::float AS delivered_qty,
       SUM(CASE WHEN LOWER(TRIM(o.status)) IN ('cancelled', 'canceled')
         THEN GREATEST(COALESCE(o.quantity, 1), 1) ELSE 0 END)::float AS cancelled_qty
     FROM orders o
     WHERE o.profile_id = $1
       AND o.product_id IS NOT NULL
       AND LOWER(TRIM(o.marketplace)) IN ('ozon', 'wb', 'wildberries', 'ym', 'yandex', 'yandexmarket')
       AND LOWER(TRIM(o.status)) IN ('delivered', 'cancelled', 'canceled')
       AND COALESCE(o.terminal_status_at, o.created_at, o.updated_at)
           >= (CURRENT_TIMESTAMP - ($2::text || ' days')::interval)
     GROUP BY o.product_id, LOWER(TRIM(o.marketplace))`,
    [profileId, String(days)]
  );
  return r.rows || [];
}

async function loadFboSalesReturns(profileId, days) {
  try {
    const r = await query(
      `SELECT
         l.product_id,
         LOWER(TRIM(l.marketplace)) AS marketplace,
         SUM(CASE WHEN ${FBO_SALE} THEN GREATEST(ABS(COALESCE(l.quantity, 0)), 0) ELSE 0 END)::float AS sold_qty,
         SUM(CASE WHEN ${FBO_RETURN} THEN GREATEST(ABS(COALESCE(l.quantity, 0)), 0) ELSE 0 END)::float AS return_qty
       FROM marketplace_fbo_report_lines l
       WHERE l.profile_id = $1
         AND l.product_id IS NOT NULL
         AND l.operation_date >= (CURRENT_DATE - ($2::int))
         AND l.operation_date <= CURRENT_DATE
       GROUP BY l.product_id, LOWER(TRIM(l.marketplace))`,
      [profileId, days]
    );
    return r.rows || [];
  } catch (e) {
    if (String(e.message || '').includes('marketplace_fbo_report_lines')) {
      logger.warn('[BuyoutDaily] FBO report table missing — skip FBO part');
      return [];
    }
    throw e;
  }
}

function mergeRates(fbsRows, fboRows, minSample) {
  const acc = new Map();
  for (const row of fbsRows) {
    addQty(acc, row.product_id, row.marketplace, 'delivered', row.delivered_qty);
    addQty(acc, row.product_id, row.marketplace, 'returned', row.cancelled_qty);
  }
  for (const row of fboRows) {
    addQty(acc, row.product_id, row.marketplace, 'delivered', row.sold_qty);
    addQty(acc, row.product_id, row.marketplace, 'returned', row.return_qty);
  }

  /** @type {Map<number, { ozon?: number, wb?: number, ym?: number }>} */
  const byProduct = new Map();
  for (const row of acc.values()) {
    const pct = computeBuyoutPercent(row.delivered, row.returned, minSample);
    if (pct == null) continue;
    if (!byProduct.has(row.productId)) byProduct.set(row.productId, {});
    byProduct.get(row.productId)[row.marketplace] = pct;
  }
  return byProduct;
}

function averageOf(rates) {
  const vals = [rates.ozon, rates.wb, rates.ym].filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return Math.round(vals.reduce((s, x) => s + x, 0) / vals.length);
}

/**
 * Пересчитать % выкупа всех товаров профиля за окно (по умолчанию 30 дней).
 */
export async function recalculateBuyoutRatesForProfile(profileId, options = {}) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) {
    return { ok: false, error: 'invalid_profile' };
  }
  const days = Number(options.windowDays) > 0 ? Number(options.windowDays) : windowDays();
  const minSample = Number(options.minUnits) > 0 ? Number(options.minUnits) : minUnits();

  const [fbsRows, fboRows] = await Promise.all([
    loadFbsTerminals(pid, days),
    loadFboSalesReturns(pid, days),
  ]);
  const byProduct = mergeRates(fbsRows, fboRows, minSample);

  let updated = 0;
  const ids = [...byProduct.keys()];
  const chunkSize = 200;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let n = 1;
    for (const productId of chunk) {
      const rates = byProduct.get(productId) || {};
      const avg = averageOf(rates);
      values.push(`($${n++}::bigint, $${n++}::int, $${n++}::int, $${n++}::int, $${n++}::int)`);
      params.push(
        productId,
        rates.ozon ?? null,
        rates.wb ?? null,
        rates.ym ?? null,
        avg
      );
    }
    const result = await query(
      `UPDATE products p
       SET
         buyout_rate_ozon = COALESCE(v.ozon, p.buyout_rate_ozon),
         buyout_rate_wb = COALESCE(v.wb, p.buyout_rate_wb),
         buyout_rate_ym = COALESCE(v.ym, p.buyout_rate_ym),
         buyout_rate = COALESCE(v.avg, p.buyout_rate),
         updated_at = CURRENT_TIMESTAMP
       FROM (VALUES ${values.join(', ')}) AS v(product_id, ozon, wb, ym, avg)
       WHERE p.id = v.product_id AND p.profile_id = $${n}`,
      [...params, pid]
    );
    updated += result.rowCount || 0;
  }

  logger.info('[BuyoutDaily] Recalculated', {
    profileId: pid,
    days,
    minSample,
    productsWithData: ids.length,
    updated,
    fbsRows: fbsRows.length,
    fboRows: fboRows.length,
  });

  return {
    ok: true,
    profileId: pid,
    windowDays: days,
    minUnits: minSample,
    productsWithData: ids.length,
    updated,
  };
}

export async function recalculateBuyoutRatesForAllProfiles(options = {}) {
  const r = await query(`SELECT id FROM profiles ORDER BY id`);
  const results = [];
  for (const row of r.rows || []) {
    try {
      results.push(await recalculateBuyoutRatesForProfile(row.id, options));
    } catch (e) {
      logger.error('[BuyoutDaily] profile failed', { profileId: row.id, message: e?.message || String(e) });
      results.push({ ok: false, profileId: Number(row.id), error: e?.message || String(e) });
    }
  }
  return { ok: true, results };
}

export default {
  recalculateBuyoutRatesForProfile,
  recalculateBuyoutRatesForAllProfiles,
};
