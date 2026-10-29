/**
 * Подтягивание FBS-логистики Ozon к факту из финансовых отчётов.
 *
 * В калькуляторе API даёт fbs_direct_flow_trans_min_amount (минимум) + delivery_amount.
 * В начислениях факт = Logistic + LastMile + DeliveryToHandover… — обычно выше минимума.
 * Поднимаем logistics_cost так, чтобы logistics_cost + delivery_amount ≥ медианы факта.
 */

import { query } from '../config/database.js';
import logger from './logger.js';

const DEFAULT_LOOKBACK_DAYS = Number(process.env.OZON_LOGISTICS_LEARN_DAYS || 60);
const DEFAULT_MIN_PRODUCT_SAMPLES = Number(process.env.OZON_LOGISTICS_LEARN_MIN_PRODUCT || 2);
const DEFAULT_MIN_BUCKET_SAMPLES = Number(process.env.OZON_LOGISTICS_LEARN_MIN_BUCKET || 5);

/** @type {{ byProductId: Map<string, { median: number, n: number }>, byVolumeBucket: Map<string, { median: number, n: number }>, loadedAt: number }|null} */
let memoryCache = null;
const MEMORY_TTL_MS = 5 * 60 * 1000;

export function volumeBucketKey(volumeLiters) {
  const v = Number(volumeLiters);
  if (!Number.isFinite(v) || v <= 0) return null;
  // Полулитровые корзины: "0.5", "1.0", "1.5", … (как round(...,1)::text в SQL)
  return (Math.max(0.5, Math.round(v * 2) / 2)).toFixed(1);
}

function finitePositive(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/**
 * @returns {Promise<{
 *   byProductId: Map<string, { median: number, n: number }>,
 *   byVolumeBucket: Map<string, { median: number, n: number }>,
 * }>}
 */
export async function loadOzonFbsLogisticsLearned(options = {}) {
  const now = Date.now();
  if (memoryCache && now - memoryCache.loadedAt < MEMORY_TTL_MS && !options.force) {
    return memoryCache;
  }

  const lookbackDays = Math.max(7, Number(options.lookbackDays) || DEFAULT_LOOKBACK_DAYS);
  const minProduct = Math.max(1, Number(options.minProductSamples) || DEFAULT_MIN_PRODUCT_SAMPLES);
  const minBucket = Math.max(1, Number(options.minBucketSamples) || DEFAULT_MIN_BUCKET_SAMPLES);

  const byProductId = new Map();
  const byVolumeBucket = new Map();

  try {
    const productRes = await query(
      `
      SELECT l.product_id::text AS product_id,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.logistics_amount)::numeric, 2) AS median,
             count(*)::int AS n
        FROM marketplace_fbs_report_lines l
       WHERE LOWER(TRIM(l.marketplace)) = 'ozon'
         AND l.operation_type = 'OperationAgentDeliveredToCustomer'
         AND l.product_id IS NOT NULL
         AND l.retail_amount > 0
         AND l.logistics_amount > 0
         AND l.operation_date >= (CURRENT_DATE - ($1::int || ' days')::interval)
       GROUP BY l.product_id
      HAVING count(*) >= $2
      `,
      [lookbackDays, minProduct]
    );
    for (const row of productRes.rows || []) {
      const median = finitePositive(row.median);
      if (!median) continue;
      byProductId.set(String(row.product_id), { median, n: Number(row.n) || 0 });
    }

    const bucketRes = await query(
      `
      WITH sales AS (
        SELECT l.logistics_amount,
               COALESCE(
                 NULLIF(p.volume, 0),
                 NULLIF((c.calculator->>'volume_weight')::numeric, 0)
               ) AS vol
          FROM marketplace_fbs_report_lines l
          JOIN products p ON p.id = l.product_id
          LEFT JOIN product_mp_calculator_cache c
            ON c.product_id = l.product_id AND c.marketplace = 'ozon'
         WHERE LOWER(TRIM(l.marketplace)) = 'ozon'
           AND l.operation_type = 'OperationAgentDeliveredToCustomer'
           AND l.retail_amount > 0
           AND l.logistics_amount > 0
           AND l.operation_date >= (CURRENT_DATE - ($1::int || ' days')::interval)
      )
      SELECT CASE
               WHEN vol IS NULL OR vol <= 0 THEN NULL
               ELSE round((GREATEST(0.5, round(vol * 2) / 2))::numeric, 1)::text
             END AS bucket,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY logistics_amount)::numeric, 2) AS median,
             count(*)::int AS n
        FROM sales
       WHERE vol IS NOT NULL AND vol > 0
       GROUP BY 1
      HAVING count(*) >= $2
      `,
      [lookbackDays, minBucket]
    );
    for (const row of bucketRes.rows || []) {
      if (!row.bucket) continue;
      const median = finitePositive(row.median);
      if (!median) continue;
      byVolumeBucket.set(String(row.bucket), { median, n: Number(row.n) || 0 });
    }
  } catch (e) {
    logger.warn('[ozonLogisticsLearning] load failed', { error: e?.message || e });
  }

  memoryCache = { byProductId, byVolumeBucket, loadedAt: now };
  return memoryCache;
}

export function clearOzonFbsLogisticsLearnedCache() {
  memoryCache = null;
}

/**
 * @param {object|null|undefined} calculator
 * @param {{ byProductId?: Map, byVolumeBucket?: Map }|null} learned
 * @param {{ productId?: string|number|null }} [opts]
 */
export function resolveLearnedOzonFbsLogisticsTotal(calculator, learned, opts = {}) {
  if (!learned) return null;
  const productId = opts.productId != null ? String(opts.productId) : null;
  if (productId && learned.byProductId?.has(productId)) {
    const hit = learned.byProductId.get(productId);
    return {
      total: hit.median,
      n: hit.n,
      source: 'fbs_reports_product',
    };
  }
  const vol =
    finitePositive(calculator?.volume_weight) ??
    finitePositive(opts.volumeLiters);
  const bucket = volumeBucketKey(vol);
  if (bucket && learned.byVolumeBucket?.has(bucket)) {
    const hit = learned.byVolumeBucket.get(bucket);
    return {
      total: hit.median,
      n: hit.n,
      source: 'fbs_reports_volume',
      volumeBucket: bucket,
    };
  }
  return null;
}

/**
 * Поднять logistics_cost (direct flow), чтобы сумма с delivery_amount ≥ learned total.
 * API-min и max не трогаем для отображения диапазона — пишем logistics_cost_api.
 *
 * @param {object|null|undefined} calculator
 * @param {number|null|undefined} learnedTotal
 * @param {{ n?: number, source?: string, volumeBucket?: string }} [meta]
 */
export function applyLearnedOzonFbsLogistics(calculator, learnedTotal, meta = {}) {
  if (!calculator || typeof calculator !== 'object') return calculator;
  const total = finitePositive(learnedTotal);
  if (total == null) return calculator;

  const calc = {
    ...calculator,
    commissions: calculator.commissions ? { ...calculator.commissions } : {},
  };
  if (calc.commissions.FBS && typeof calc.commissions.FBS === 'object') {
    calc.commissions.FBS = { ...calc.commissions.FBS };
  }

  const delivery = finitePositive(calc.commissions?.FBS?.delivery_amount) || 0;
  const currentDf =
    finitePositive(calc.logistics_cost_api) ||
    finitePositive(calc.logistics_cost) ||
    finitePositive(calc.commissions?.FBS?.direct_flow_trans_amount) ||
    0;
  const currentTotal = currentDf + delivery;

  if (calc.logistics_cost_api == null && currentDf > 0) {
    calc.logistics_cost_api = currentDf;
  }

  calc.logistics_learned = {
    total: Math.round(total * 100) / 100,
    n: Number(meta.n) || 0,
    source: meta.source || 'fbs_reports',
    ...(meta.volumeBucket ? { volumeBucket: meta.volumeBucket } : {}),
  };

  if (total <= currentTotal + 0.005) {
    return calc;
  }

  const newDf = Math.round((total - delivery) * 100) / 100;
  calc.logistics_cost = newDf;
  if (calc.commissions.FBS) {
    calc.commissions.FBS.direct_flow_trans_amount = newDf;
  }
  return calc;
}

/**
 * @param {object|null|undefined} calculator
 * @param {{ byProductId?: Map, byVolumeBucket?: Map }|null} learned
 * @param {{ productId?: string|number|null, volumeLiters?: number|null }} [opts]
 */
export function enrichOzonCalculatorWithLearnedLogistics(calculator, learned, opts = {}) {
  const hit = resolveLearnedOzonFbsLogisticsTotal(calculator, learned, opts);
  if (!hit) return calculator;
  return applyLearnedOzonFbsLogistics(calculator, hit.total, hit);
}
