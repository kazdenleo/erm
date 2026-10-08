/**
 * Аналитика возвратов и отмен по товарам.
 *
 * Возвраты после выкупа — строки сторно продажи (WB «Возврат», Ozon ClientReturnAgentOperation / Storno).
 * Обратная логистика (возвраты + невыкупы + отмены в пути): WB — логистика с return_amount > 0,
 * Ozon — OperationItemReturn / OperationReturnGoodsFBSofRMS, Я.Маркет — строки «возврат / невыкуп».
 * Отмены — заказы FBS в статусе cancelled. Причины — заявки на возврат (marketplace_return_claims).
 */

import { query } from '../config/database.js';
import { sqlOzonSkuMapCte } from '../utils/offerArticleKey.js';
import {
  SALE_LINE,
  RETURN_SALE_LINE,
  SQL_RETURNED_AMOUNT,
  SQL_MP_NORM,
  SQL_LINE_PRODUCT_ID,
  sqlOzonNameMapCte,
  lineProductJoins,
  sqlReportLinesUnion,
} from '../utils/marketplaceReportLineSql.js';
import {
  requireAnalyticsProfile,
  resolvePeriod,
  normalizeMp,
  normalizeScheme,
  mpDbVariants,
  normMpCode,
  round2,
  MP_LABELS,
} from '../utils/analyticsCommon.js';
import { sqlOrderOfferMapCte, sqlOrderOfferJoin, sqlOrderProductId } from '../utils/orderProductSql.js';

const MPS = ['ozon', 'wb', 'ym'];
export const HIGH_RETURNS_DEFAULTS = { minReturns: 3, ratePercent: 10, days: 90 };

const WB_RETURN_AMOUNT = `CASE WHEN (l.raw_json->>'return_amount') ~ '^[0-9]+(\\.[0-9]+)?$'
  THEN (l.raw_json->>'return_amount')::numeric ELSE 0 END`;

const REVERSE_LINE = `(
  (LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') AND l.operation_type <> 'Возврат' AND ${WB_RETURN_AMOUNT} > 0)
  OR (LOWER(TRIM(l.marketplace)) = 'ozon' AND l.operation_type IN ('OperationItemReturn', 'OperationReturnGoodsFBSofRMS'))
  OR (LOWER(TRIM(l.marketplace)) IN ('ym', 'yandex', 'yandexmarket')
      AND (l.operation_type ILIKE '%возврат%' OR l.operation_type ILIKE '%невыкуп%'))
)`;

const REVERSE_COUNT = `CASE
  WHEN LOWER(TRIM(l.marketplace)) IN ('wb', 'wildberries') THEN ${WB_RETURN_AMOUNT}
  WHEN LOWER(TRIM(l.marketplace)) = 'ozon' THEN
    CASE WHEN l.operation_type = 'OperationItemReturn' THEN GREATEST(ABS(l.quantity), 1) ELSE 0 END
  ELSE GREATEST(ABS(l.quantity), 1)
END`;

const REVERSE_COST = `GREATEST(ABS(l.logistics_amount), ABS(LEAST(l.payout_amount, 0)))`;

export const RETURN_REASON_LABELS = {
  fitment: 'Не подошло / применимость',
  mismatch: 'Не соответствует описанию / комплектация',
  defect: 'Брак / повреждение',
  changed_mind: 'Передумал / не нужен',
  other: 'Другое',
};

const REASON_PATTERNS = [
  ['defect', /брак|слома|поврежд|трещ|не работ|дефект|разбит|бракован|протек|гнут|царап/i],
  ['fitment', /не подош|не подход|примени|не на (мою|мой|эту|этот|ту|тот)|не тот|не та |не те |размер|не встал|не совпад|другая модель|не для/i],
  ['mismatch', /не соответ|описани|комплект|не то,? что|не что заказ|пришл[оа] не|другой товар|фото|не хватает|недоклад|некомплект/i],
  ['changed_mind', /передумал|не нужен|не нужн|ошибочно|случайно|нашел дешевле|нашёл дешевле|долго/i],
];

export function classifyReturnReason(...texts) {
  const text = texts.filter(Boolean).join(' ').toLowerCase();
  if (!text.trim()) return 'other';
  for (const [code, re] of REASON_PATTERNS) {
    if (re.test(text)) return code;
  }
  return 'other';
}

function flagHint(topReason) {
  if (topReason === 'fitment') return 'Много возвратов «не подошло»: проверьте применимость (марки, модели, годы) в карточке.';
  if (topReason === 'mismatch') return 'Много возвратов «не соответствует»: проверьте описание, фото и комплектацию.';
  if (topReason === 'defect') return 'Много возвратов по браку: проверьте партию и поставщика.';
  return 'Много возвратов: проверьте применимость и описание карточки.';
}

class ReturnsAnalyticsService {
  async getReturns({
    profileId,
    dateFrom,
    dateTo,
    marketplace = 'all',
    scheme = 'all',
    minReturns = HIGH_RETURNS_DEFAULTS.minReturns,
    ratePercent = HIGH_RETURNS_DEFAULTS.ratePercent,
    limit = 1000,
  } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const { fromYmd, toYmd, days } = resolvePeriod(dateFrom, dateTo, HIGH_RETURNS_DEFAULTS.days);
    const mpFilter = normalizeMp(marketplace);
    const schemeNorm = normalizeScheme(scheme);
    const minRet = Math.max(1, Number(minReturns) || HIGH_RETURNS_DEFAULTS.minReturns);
    const rateThr = Math.max(0.1, Number(ratePercent) || HIGH_RETURNS_DEFAULTS.ratePercent);
    const mpVariants = mpDbVariants(mpFilter);

    const linesSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT ${SQL_LINE_PRODUCT_ID} AS product_id, ${SQL_MP_NORM} AS mp,
             SUM(CASE WHEN ${SALE_LINE} THEN GREATEST(l.quantity, 0) ELSE 0 END)::numeric AS sold_qty,
             SUM(CASE WHEN ${SALE_LINE} THEN l.retail_amount ELSE 0 END)::numeric AS sold_amount,
             SUM(CASE WHEN ${RETURN_SALE_LINE} THEN GREATEST(ABS(l.quantity), 1) ELSE 0 END)::numeric AS returned_qty,
             SUM(CASE WHEN ${RETURN_SALE_LINE} THEN ${SQL_RETURNED_AMOUNT} ELSE 0 END)::numeric AS returned_amount,
             SUM(CASE WHEN ${REVERSE_LINE} THEN ${REVERSE_COUNT} ELSE 0 END)::numeric AS reverse_count,
             SUM(CASE WHEN ${REVERSE_LINE} THEN ${REVERSE_COST} ELSE 0 END)::numeric AS reverse_cost
        FROM ${sqlReportLinesUnion(schemeNorm, 'AND r.operation_date >= $2::date AND r.operation_date <= $3::date')} l
        ${lineProductJoins()}
       WHERE ${SQL_LINE_PRODUCT_ID} IS NOT NULL
       GROUP BY 1, 2`;

    const ordersParams = [pid, fromYmd, toYmd];
    if (mpVariants) ordersParams.push(mpVariants);
    const ordersSql = `
      WITH ${sqlOrderOfferMapCte()}
      SELECT ${sqlOrderProductId('o')} AS product_id, LOWER(TRIM(o.marketplace)) AS mp,
             COUNT(*)::int AS orders,
             COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(o.status, ''))) = 'cancelled')::int AS cancelled
        FROM orders o
        ${sqlOrderOfferJoin('o')}
       WHERE o.profile_id = $1 AND ${sqlOrderProductId('o')} IS NOT NULL
         AND o.created_at >= ($2::date)::timestamp AT TIME ZONE 'Europe/Moscow'
         AND o.created_at < ($3::date)::timestamp AT TIME ZONE 'Europe/Moscow' + INTERVAL '1 day'
         ${mpVariants ? 'AND LOWER(TRIM(o.marketplace)) = ANY($4::text[])' : ''}
       GROUP BY 1, 2`;

    const claimsSql = `
      SELECT c.id, c.marketplace, c.reason, c.buyer_comment, c.sku_or_offer, c.product_name,
             COALESCE(c.source_created_at, c.created_at) AS created_at,
             COALESCE(
               (SELECT ps.product_id FROM product_skus ps
                  JOIN products p ON p.id = ps.product_id AND p.profile_id = $1
                 WHERE ps.marketplace = CASE LOWER(TRIM(c.marketplace))
                         WHEN 'wildberries' THEN 'wb' WHEN 'yandex' THEN 'ym' ELSE LOWER(TRIM(c.marketplace)) END
                   AND (TRIM(ps.sku) = TRIM(c.sku_or_offer)
                        OR (TRIM(c.sku_or_offer) ~ '^[0-9]+$' AND ps.marketplace_product_id = TRIM(c.sku_or_offer)::bigint))
                 LIMIT 1),
               (SELECT p.id FROM products p WHERE p.profile_id = $1 AND TRIM(p.sku) = TRIM(c.sku_or_offer) LIMIT 1)
             ) AS product_id
        FROM marketplace_return_claims c
       WHERE c.profile_id = $1
         AND COALESCE(c.source_created_at, c.created_at) >= ($2::date)::timestamp AT TIME ZONE 'Europe/Moscow'
         AND COALESCE(c.source_created_at, c.created_at) < ($3::date)::timestamp AT TIME ZONE 'Europe/Moscow' + INTERVAL '1 day'`;

    const [linesRes, ordersRes, claimsRes] = await Promise.all([
      query(linesSql, [pid, fromYmd, toYmd]),
      schemeNorm === 'fbo' ? { rows: [] } : query(ordersSql, ordersParams),
      query(claimsSql, [pid, fromYmd, toYmd]).catch(() => ({ rows: [] })),
    ]);

    const map = new Map();
    const get = (mp, productId) => {
      const key = `${mp}|${productId}`;
      if (!map.has(key)) {
        map.set(key, {
          productId,
          marketplace: mp,
          soldQty: 0,
          soldAmount: 0,
          returnedQty: 0,
          returnedAmount: 0,
          reverseCount: 0,
          reverseCost: 0,
          orders: 0,
          cancelled: 0,
          reasons: {},
          comments: [],
        });
      }
      return map.get(key);
    };

    for (const r of linesRes.rows || []) {
      const mp = normMpCode(r.mp);
      if (!MPS.includes(mp) || (mpFilter !== 'all' && mp !== mpFilter)) continue;
      const it = get(mp, Number(r.product_id));
      it.soldQty += Number(r.sold_qty) || 0;
      it.soldAmount += Number(r.sold_amount) || 0;
      it.returnedQty += Number(r.returned_qty) || 0;
      it.returnedAmount += Number(r.returned_amount) || 0;
      it.reverseCount += Number(r.reverse_count) || 0;
      it.reverseCost += Number(r.reverse_cost) || 0;
    }
    for (const r of ordersRes.rows || []) {
      const mp = normMpCode(r.mp);
      if (!MPS.includes(mp)) continue;
      const it = get(mp, Number(r.product_id));
      it.orders += Number(r.orders) || 0;
      it.cancelled += Number(r.cancelled) || 0;
    }
    const reasonTotals = Object.fromEntries(Object.keys(RETURN_REASON_LABELS).map((k) => [k, 0]));
    for (const c of claimsRes.rows || []) {
      const mp = normMpCode(c.marketplace);
      if (mpFilter !== 'all' && mp !== mpFilter) continue;
      const code = classifyReturnReason(c.reason, c.buyer_comment);
      reasonTotals[code] += 1;
      if (c.product_id == null) continue;
      const it = get(mp, Number(c.product_id));
      it.reasons[code] = (it.reasons[code] || 0) + 1;
      if (it.comments.length < 5) {
        it.comments.push({ reason: c.reason || null, comment: c.buyer_comment || null, date: c.created_at });
      }
    }

    const items = [];
    for (const it of map.values()) {
      if (!it.soldQty && !it.returnedQty && !it.reverseCount && !it.orders) continue;
      const returnRate = it.soldQty > 0 ? (it.returnedQty / it.soldQty) * 100 : it.returnedQty > 0 ? 100 : null;
      const nonPurchase = Math.max(0, it.reverseCount - it.returnedQty);
      const nonPurchaseRate = it.soldQty + nonPurchase > 0 ? (nonPurchase / (it.soldQty + nonPurchase)) * 100 : null;
      const cancelRate = it.orders > 0 ? (it.cancelled / it.orders) * 100 : null;
      const topReason = Object.entries(it.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const highReturns = it.returnedQty >= minRet && returnRate != null && returnRate >= rateThr;
      items.push({
        productId: it.productId,
        marketplace: it.marketplace,
        soldQty: Math.round(it.soldQty),
        soldAmount: round2(it.soldAmount),
        returnedQty: Math.round(it.returnedQty),
        returnedAmount: round2(it.returnedAmount),
        returnRate: returnRate != null ? round2(returnRate) : null,
        nonPurchaseQty: Math.round(nonPurchase),
        nonPurchaseRate: nonPurchaseRate != null ? round2(nonPurchaseRate) : null,
        reverseLogisticsCost: round2(it.reverseCost),
        reverseCostPerSale: it.soldQty > 0 ? round2(it.reverseCost / it.soldQty) : null,
        orders: it.orders,
        cancelled: it.cancelled,
        cancelRate: cancelRate != null ? round2(cancelRate) : null,
        reasons: it.reasons,
        topReason,
        topReasonLabel: topReason ? RETURN_REASON_LABELS[topReason] : null,
        comments: it.comments,
        highReturns,
        flagHint: highReturns ? flagHint(topReason) : null,
      });
    }

    const productIds = [...new Set(items.map((i) => i.productId))];
    if (productIds.length) {
      const pr = await query('SELECT id, name, sku FROM products WHERE id = ANY($1::bigint[])', [productIds]);
      const byId = new Map((pr.rows || []).map((r) => [Number(r.id), r]));
      for (const it of items) {
        const p = byId.get(it.productId);
        it.productName = p?.name || '—';
        it.productSku = p?.sku || '';
      }
    }

    items.sort(
      (a, b) =>
        Number(b.highReturns) - Number(a.highReturns) ||
        b.returnedQty - a.returnedQty ||
        b.reverseLogisticsCost - a.reverseLogisticsCost
    );

    const sum = (f) => items.reduce((s, i) => s + (Number(i[f]) || 0), 0);
    const soldQty = sum('soldQty');
    const returnedQty = sum('returnedQty');
    const nonPurchaseQty = sum('nonPurchaseQty');
    const orders = sum('orders');
    const cancelled = sum('cancelled');
    const byMarketplace = MPS.filter((mp) => mpFilter === 'all' || mp === mpFilter).map((mp) => {
      const list = items.filter((i) => i.marketplace === mp);
      const s = (f) => list.reduce((acc, i) => acc + (Number(i[f]) || 0), 0);
      const sold = s('soldQty');
      const ret = s('returnedQty');
      return {
        marketplace: mp,
        label: MP_LABELS[mp],
        soldQty: sold,
        returnedQty: ret,
        returnRate: sold > 0 ? round2((ret / sold) * 100) : null,
        nonPurchaseQty: s('nonPurchaseQty'),
        reverseLogisticsCost: round2(s('reverseLogisticsCost')),
        cancelled: s('cancelled'),
        orders: s('orders'),
      };
    });

    const lim = Math.min(3000, Math.max(1, Number(limit) || 1000));
    return {
      period: { dateFrom: fromYmd, dateTo: toYmd, days },
      filters: { marketplace: mpFilter, scheme: schemeNorm },
      thresholds: { minReturns: minRet, ratePercent: rateThr },
      summary: {
        soldQty,
        returnedQty,
        returnRate: soldQty > 0 ? round2((returnedQty / soldQty) * 100) : null,
        returnedAmount: round2(sum('returnedAmount')),
        nonPurchaseQty,
        nonPurchaseRate: soldQty + nonPurchaseQty > 0 ? round2((nonPurchaseQty / (soldQty + nonPurchaseQty)) * 100) : null,
        reverseLogisticsCost: round2(sum('reverseLogisticsCost')),
        orders,
        cancelled,
        cancelRate: orders > 0 ? round2((cancelled / orders) * 100) : null,
        flaggedCount: items.filter((i) => i.highReturns).length,
        claimsCount: (claimsRes.rows || []).length,
        reasons: Object.entries(reasonTotals).map(([code, count]) => ({ code, label: RETURN_REASON_LABELS[code], count })),
        byMarketplace,
      },
      items: items.slice(0, lim),
      totalItems: items.length,
    };
  }

  /** Товары с высокой долей возвратов — для «Работы с карточками». */
  async listHighReturns({ profileId, marketplace = 'all' } = {}) {
    const data = await this.getReturns({ profileId, marketplace, limit: 3000 });
    return data.items.filter((i) => i.highReturns);
  }
}

export default new ReturnsAnalyticsService();
