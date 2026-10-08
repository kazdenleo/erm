/**
 * Штрафы и удержания маркетплейсов.
 *
 *  - штрафы по типам (WB bonus_type_name, Ozon operation_type_name) и категориям, по товарам;
 *  - сверка с расхождением габаритов из «Работы с карточками» (перемер, переплата логистики);
 *  - компенсации МП: сумма за штуку против себестоимости и средней цены продажи;
 *  - доставленные заказы FBS без начисления в финотчёте (задержка выплаты) и средний лаг начисления.
 */

import { query } from '../config/database.js';
import { sqlOzonSkuMapCte } from '../utils/offerArticleKey.js';
import {
  SALE_LINE,
  SQL_MP_NORM,
  SQL_LINE_PRODUCT_ID,
  sqlOzonNameMapCte,
  lineProductJoins,
  sqlReportLinesUnion,
} from '../utils/marketplaceReportLineSql.js';
import {
  requireAnalyticsProfile,
  resolvePeriod,
  addDaysYmd,
  normalizeMp,
  normalizeScheme,
  normMpCode,
  round2,
  MP_LABELS,
} from '../utils/analyticsCommon.js';
import { listPackDimensionMismatches } from './marketplaceCardWork.service.js';

const MPS = ['ozon', 'wb', 'ym'];

export const PENALTY_CATEGORIES = {
  dims: 'Габариты / перемер',
  shipment: 'Сроки отгрузки и слоты',
  cancel: 'Отмены продавцом',
  returns_storage: 'Хранение возвратов на ПВЗ',
  labeling: 'Маркировка и упаковка',
  other: 'Прочие штрафы',
};

const CATEGORY_PATTERNS = [
  ['returns_storage', /хранени[ея] возврат|возврат\w* на пвз/i],
  ['dims', /габарит|перемер|объ[её]м|занижени|несоответстви\w* (размер|вес|характ)|volume|weight/i],
  ['cancel', /отмен|невыполнен|cancel/i],
  ['labeling', /маркиров|этикет|штрихкод|стикер|label/i],
  ['shipment', /срок|просроч|опозд|задерж|слот|отгрузк|иной сц|delay|shipment/i],
];

export function classifyPenalty(name) {
  const text = String(name || '');
  for (const [code, re] of CATEGORY_PATTERNS) {
    if (re.test(text)) return code;
  }
  return 'other';
}

const PENALTY_NAME = `COALESCE(NULLIF(TRIM(l.raw_json->>'bonus_type_name'), ''), NULLIF(TRIM(l.raw_json->>'operation_type_name'), ''), l.operation_type)`;

const PENALTY_LINE = `(
  l.penalty_amount > 0
  OR l.operation_type ILIKE 'DefectFine%'
  OR l.operation_type ILIKE '%штраф%'
  OR COALESCE(l.raw_json->>'bonus_type_name', '') ILIKE '%штраф%'
)`;

const PENALTY_AMOUNT = `CASE WHEN l.penalty_amount > 0 THEN l.penalty_amount ELSE ABS(LEAST(l.payout_amount, 0)) END`;

const COMPENSATION_LINE = `(
  (l.operation_type ILIKE '%компенсац%' OR l.operation_type ILIKE '%compensation%'
   OR (l.operation_type ILIKE '%возмещени%' AND l.operation_type NOT ILIKE '%перевозк%' AND l.operation_type NOT ILIKE '%пвз%')
   OR l.operation_type IN ('OperationClaim', 'AccrualInternalClaim', 'MarketplaceSellerCompensationOperation', 'OperationLackWriteOff'))
  AND l.operation_type NOT ILIKE '%лояльност%'
  AND l.payout_amount > 0
)`;

class PenaltiesAnalyticsService {
  async getPenalties({
    profileId,
    dateFrom,
    dateTo,
    marketplace = 'all',
    scheme = 'all',
    unpaidAfterDays = 14,
  } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const { fromYmd, toYmd, days } = resolvePeriod(dateFrom, dateTo, 90);
    const mpFilter = normalizeMp(marketplace);
    const schemeNorm = normalizeScheme(scheme);
    const lagDays = Math.max(3, Math.min(90, Number(unpaidAfterDays) || 14));
    const priceFrom = addDaysYmd(toYmd, -179);

    const penaltiesSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT ${SQL_MP_NORM} AS mp, l.scheme, ${PENALTY_NAME} AS name,
             ${SQL_LINE_PRODUCT_ID} AS product_id,
             COUNT(*)::int AS cnt,
             SUM(${PENALTY_AMOUNT})::numeric AS amount
        FROM ${sqlReportLinesUnion(schemeNorm, 'AND r.operation_date >= $2::date AND r.operation_date <= $3::date')} l
        ${lineProductJoins()}
       WHERE ${PENALTY_LINE}
       GROUP BY 1, 2, 3, 4`;

    const compensationSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT ${SQL_MP_NORM} AS mp, l.operation_type, ${SQL_LINE_PRODUCT_ID} AS product_id,
             to_char(l.operation_date, 'YYYY-MM-DD') AS d, l.order_id, l.posting_number,
             GREATEST(ABS(l.quantity), 1)::numeric AS qty, l.payout_amount::numeric AS amount,
             COALESCE(p.cost, 0)::numeric AS cost, p.name AS product_name, p.sku AS product_sku
        FROM ${sqlReportLinesUnion(schemeNorm, 'AND r.operation_date >= $2::date AND r.operation_date <= $3::date')} l
        ${lineProductJoins()}
       WHERE ${COMPENSATION_LINE}
       ORDER BY l.operation_date DESC
       LIMIT 500`;

    const avgPriceSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT ${SQL_LINE_PRODUCT_ID} AS product_id,
             SUM(l.retail_amount)::numeric AS amount, SUM(GREATEST(l.quantity, 0))::numeric AS qty
        FROM ${sqlReportLinesUnion('all', 'AND r.operation_date >= $2::date AND r.operation_date <= $3::date')} l
        ${lineProductJoins()}
       WHERE ${SALE_LINE} AND ${SQL_LINE_PRODUCT_ID} IS NOT NULL
       GROUP BY 1`;

    const logisticsSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT ${SQL_MP_NORM} AS mp, ${SQL_LINE_PRODUCT_ID} AS product_id,
             SUM(CASE WHEN ${SALE_LINE} THEN GREATEST(l.quantity, 0) ELSE 0 END)::numeric AS sold_qty,
             SUM(l.logistics_amount)::numeric AS logistics
        FROM ${sqlReportLinesUnion(schemeNorm, 'AND r.operation_date >= $2::date AND r.operation_date <= $3::date')} l
        ${lineProductJoins()}
       WHERE ${SQL_LINE_PRODUCT_ID} IS NOT NULL
       GROUP BY 1, 2`;

    // Ключи заказов с продажей в финотчётах (продажи FBS WB / ЯМ частично лежат в таблице FBO-отчёта).
    // Сопоставление делаем в JS: планировщик сильно занижает число строк продаж и уходит во вложенные циклы.
    const saleKeysSql = `
      SELECT ${SQL_MP_NORM} AS mp,
             to_char(l.operation_date, 'YYYY-MM-DD') AS d,
             NULLIF(TRIM(l.order_id), '') AS k1,
             NULLIF(TRIM(l.posting_number), '') AS k2,
             NULLIF(TRIM(l.raw_json->>'assembly_id'), '') AS k3,
             NULLIF(TRIM(l.raw_json->>'srid'), '') AS k4
        FROM ${sqlReportLinesUnion('all')} l
       WHERE ${SALE_LINE}`;

    const deliveredSql = `
      SELECT CASE LOWER(TRIM(o.marketplace)) WHEN 'wildberries' THEN 'wb' WHEN 'yandex' THEN 'ym'
                  ELSE LOWER(TRIM(o.marketplace)) END AS mp,
             COALESCE(NULLIF(o.order_group_id, ''), split_part(split_part(o.order_id, ':', 1), '~', 1)) AS order_key,
             o.order_id, o.product_id,
             GREATEST(COALESCE(o.quantity, 1), 1) * COALESCE(o.price, 0) AS amount,
             COALESCE(o.terminal_status_at, o.created_at) AS delivered_at
        FROM orders o
       WHERE o.profile_id = $1
         AND LOWER(TRIM(COALESCE(o.status, ''))) = 'delivered'
         AND COALESCE(o.terminal_status_at, o.created_at) >= ($2::date)::timestamp AT TIME ZONE 'Europe/Moscow'
         AND COALESCE(o.terminal_status_at, o.created_at) < ($3::date)::timestamp AT TIME ZONE 'Europe/Moscow' + INTERVAL '1 day'`;

    const wantUnpaid = schemeNorm !== 'fbo';
    const [penRes, compRes, priceRes, logRes, saleKeysRes, deliveredRes, dimRows] = await Promise.all([
      query(penaltiesSql, [pid, fromYmd, toYmd]),
      query(compensationSql, [pid, fromYmd, toYmd]),
      query(avgPriceSql, [pid, priceFrom, toYmd]),
      query(logisticsSql, [pid, fromYmd, toYmd]),
      wantUnpaid ? query(saleKeysSql, [pid]) : { rows: [] },
      wantUnpaid ? query(deliveredSql, [pid, fromYmd, toYmd]) : { rows: [] },
      listPackDimensionMismatches({ profileId: pid, marketplace: mpFilter }),
    ]);

    const saleDateByKey = new Map();
    const coverage = new Map();
    for (const r of saleKeysRes.rows || []) {
      const mp = normMpCode(r.mp);
      const cov = coverage.get(mp) || { min: r.d, max: r.d };
      if (r.d < cov.min) cov.min = r.d;
      if (r.d > cov.max) cov.max = r.d;
      coverage.set(mp, cov);
      for (const k of [r.k1, r.k2, r.k3, r.k4]) {
        if (!k || k === '0') continue;
        const key = `${mp}|${k}`;
        const prev = saleDateByKey.get(key);
        if (!prev || r.d < prev) saleDateByKey.set(key, r.d);
      }
    }
    const orderGroups = new Map();
    for (const r of deliveredRes.rows || []) {
      const mp = normMpCode(r.mp);
      const gKey = `${mp}|${r.order_key}`;
      const g = orderGroups.get(gKey) || {
        mp,
        order_key: r.order_key,
        delivered_at: r.delivered_at,
        product_id: r.product_id,
        amountLines: 0,
        amountBase: 0,
        keys: new Set([r.order_key]),
      };
      if (new Date(r.delivered_at) < new Date(g.delivered_at)) g.delivered_at = r.delivered_at;
      if (r.product_id != null) g.product_id = r.product_id;
      // ЯМ: строка «заказ» + строки «заказ:артикул» — сумма по строкам с артикулом, иначе по заказу
      if (String(r.order_id).includes(':')) g.amountLines += Number(r.amount) || 0;
      else g.amountBase += Number(r.amount) || 0;
      g.keys.add(String(r.order_id));
      g.keys.add(String(r.order_id).split(':')[0].split('~')[0]);
      orderGroups.set(gKey, g);
    }
    const unpaidRes = { rows: [] };
    for (const g of orderGroups.values()) {
      const cov = coverage.get(g.mp);
      if (!cov) continue;
      const deliveredYmd = new Date(g.delivered_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
      if (deliveredYmd < addDaysYmd(cov.min, 3)) continue;
      let saleDate = null;
      for (const k of g.keys) {
        const d = saleDateByKey.get(`${g.mp}|${k}`);
        if (d && (!saleDate || d < saleDate)) saleDate = d;
      }
      unpaidRes.rows.push({
        mp: g.mp,
        order_key: g.order_key,
        delivered_at: g.delivered_at,
        product_id: g.product_id,
        amount: g.amountLines > 0 ? g.amountLines : g.amountBase,
        max_d: cov.max,
        sale_date: saleDate,
      });
    }

    const mpOk = (mp) => MPS.includes(mp) && (mpFilter === 'all' || mp === mpFilter);

    // ── Штрафы
    const byType = new Map();
    const byProduct = new Map();
    const byCategory = Object.fromEntries(Object.keys(PENALTY_CATEGORIES).map((k) => [k, { count: 0, amount: 0 }]));
    const byMp = Object.fromEntries(MPS.map((mp) => [mp, 0]));
    let penaltyTotal = 0;
    for (const r of penRes.rows || []) {
      const mp = normMpCode(r.mp);
      if (!mpOk(mp)) continue;
      const amount = Number(r.amount) || 0;
      const cnt = Number(r.cnt) || 0;
      const category = classifyPenalty(r.name);
      const tKey = `${mp}|${r.name}`;
      const t = byType.get(tKey) || { marketplace: mp, name: r.name, category, count: 0, amount: 0 };
      t.count += cnt;
      t.amount += amount;
      byType.set(tKey, t);
      byCategory[category].count += cnt;
      byCategory[category].amount += amount;
      byMp[mp] += amount;
      penaltyTotal += amount;
      if (r.product_id != null) {
        const pKey = `${mp}|${Number(r.product_id)}`;
        const p = byProduct.get(pKey) || { marketplace: mp, productId: Number(r.product_id), count: 0, amount: 0, categories: {} };
        p.count += cnt;
        p.amount += amount;
        p.categories[category] = (p.categories[category] || 0) + amount;
        byProduct.set(pKey, p);
      }
    }

    // ── Средняя цена продажи (180 дн.)
    const avgPrice = new Map();
    for (const r of priceRes.rows || []) {
      const qty = Number(r.qty) || 0;
      if (qty > 0) avgPrice.set(Number(r.product_id), (Number(r.amount) || 0) / qty);
    }

    // ── Компенсации
    const compensations = [];
    for (const r of compRes.rows || []) {
      const mp = normMpCode(r.mp);
      if (!mpOk(mp)) continue;
      const qty = Number(r.qty) || 1;
      const amount = Number(r.amount) || 0;
      const perUnit = amount / qty;
      const productId = r.product_id != null ? Number(r.product_id) : null;
      const cost = Number(r.cost) || 0;
      const price = productId ? avgPrice.get(productId) || null : null;
      const belowCost = cost > 0 && perUnit < cost;
      compensations.push({
        marketplace: mp,
        date: r.d,
        operationType: r.operation_type,
        orderId: r.order_id || r.posting_number || null,
        productId,
        productName: r.product_name || '—',
        productSku: r.product_sku || '',
        quantity: qty,
        amount: round2(amount),
        perUnit: round2(perUnit),
        cost: round2(cost),
        avgPrice: price != null ? round2(price) : null,
        percentOfPrice: price ? round2((perUnit / price) * 100) : null,
        belowCost,
        underpaid: belowCost || (price != null && perUnit < price * 0.5),
        shortfall: round2(Math.max(0, (cost || 0) - perUnit) * qty),
      });
    }

    // ── Габариты: сверка расхождений карточки со штрафами и логистикой
    const logistics = new Map();
    for (const r of logRes.rows || []) {
      const mp = normMpCode(r.mp);
      logistics.set(`${mp}|${Number(r.product_id)}`, {
        soldQty: Number(r.sold_qty) || 0,
        logistics: Number(r.logistics) || 0,
      });
    }
    const mpLogisticsMedian = {};
    for (const mp of MPS) {
      const vals = [...logistics.entries()]
        .filter(([k, v]) => k.startsWith(`${mp}|`) && v.soldQty >= 3)
        .map(([, v]) => v.logistics / v.soldQty)
        .sort((a, b) => a - b);
      mpLogisticsMedian[mp] = vals.length ? vals[Math.floor(vals.length / 2)] : null;
    }
    const dimensionIssues = (dimRows || [])
      .filter((d) => mpOk(d.marketplace))
      .map((d) => {
        const key = `${d.marketplace}|${d.productId}`;
        const lg = logistics.get(key);
        const pen = byProduct.get(key);
        const perUnit = lg && lg.soldQty > 0 ? lg.logistics / lg.soldQty : null;
        return {
          marketplace: d.marketplace,
          productId: d.productId,
          productName: d.productName,
          productSku: d.sku,
          hint: d.hint,
          soldQty: lg ? Math.round(lg.soldQty) : 0,
          logisticsPerUnit: perUnit != null ? round2(perUnit) : null,
          dimsPenalty: round2(pen?.categories?.dims || 0),
          penaltyTotal: round2(pen?.amount || 0),
          logisticsAmount: round2(lg?.logistics || 0),
        };
      })
      .sort((a, b) => b.dimsPenalty - a.dimsPenalty || b.logisticsAmount - a.logisticsAmount);

    // ── Доставлено, но не начислено
    const today = new Date();
    const unpaid = [];
    const lagStats = Object.fromEntries(MPS.map((mp) => [mp, { lags: [], orders: 0 }]));
    for (const r of unpaidRes.rows || []) {
      const mp = normMpCode(r.mp);
      if (!mpOk(mp)) continue;
      const delivered = new Date(r.delivered_at);
      const maxD = r.max_d ? new Date(r.max_d) : null;
      lagStats[mp].orders += 1;
      if (r.sale_date) {
        const lag = Math.round((new Date(r.sale_date) - delivered) / 86400000);
        if (lag >= -3 && lag <= 120) lagStats[mp].lags.push(Math.max(0, lag));
        continue;
      }
      // Отчёт ещё не покрывает дату доставки + запас — рано считать задержкой
      if (!maxD || delivered.getTime() > maxD.getTime() - lagDays * 86400000) continue;
      unpaid.push({
        marketplace: mp,
        orderId: r.order_key,
        productId: r.product_id != null ? Number(r.product_id) : null,
        deliveredAt: r.delivered_at,
        daysSinceDelivery: Math.floor((today - delivered) / 86400000),
        amount: round2(Number(r.amount) || 0),
      });
    }
    const payoutLag = MPS.filter(mpOk).map((mp) => {
      const lags = lagStats[mp].lags.sort((a, b) => a - b);
      return {
        marketplace: mp,
        label: MP_LABELS[mp],
        deliveredOrders: lagStats[mp].orders,
        matched: lags.length,
        avgLagDays: lags.length ? round2(lags.reduce((s, v) => s + v, 0) / lags.length) : null,
        medianLagDays: lags.length ? lags[Math.floor(lags.length / 2)] : null,
        unpaidCount: unpaid.filter((u) => u.marketplace === mp).length,
        unpaidAmount: round2(unpaid.filter((u) => u.marketplace === mp).reduce((s, u) => s + u.amount, 0)),
      };
    });
    unpaid.sort((a, b) => b.daysSinceDelivery - a.daysSinceDelivery);

    // Названия товаров
    const ids = new Set([
      ...[...byProduct.values()].map((p) => p.productId),
      ...unpaid.map((u) => u.productId).filter(Boolean),
    ]);
    const names = new Map();
    if (ids.size) {
      const pr = await query('SELECT id, name, sku FROM products WHERE id = ANY($1::bigint[])', [[...ids]]);
      for (const r of pr.rows || []) names.set(Number(r.id), r);
    }
    const withName = (o) => ({
      ...o,
      productName: o.productName || names.get(o.productId)?.name || '—',
      productSku: o.productSku || names.get(o.productId)?.sku || '',
    });

    const penaltyTypes = [...byType.values()]
      .map((t) => ({ ...t, categoryLabel: PENALTY_CATEGORIES[t.category], amount: round2(t.amount) }))
      .sort((a, b) => b.amount - a.amount);
    const penaltyProducts = [...byProduct.values()]
      .map((p) => withName({
        ...p,
        amount: round2(p.amount),
        topCategory: Object.entries(p.categories).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other',
      }))
      .map((p) => ({ ...p, topCategoryLabel: PENALTY_CATEGORIES[p.topCategory] }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 300);

    const underpaid = compensations.filter((c) => c.underpaid);
    return {
      period: { dateFrom: fromYmd, dateTo: toYmd, days },
      filters: { marketplace: mpFilter, scheme: schemeNorm, unpaidAfterDays: lagDays },
      categories: PENALTY_CATEGORIES,
      summary: {
        penaltyTotal: round2(penaltyTotal),
        penaltyCount: penaltyTypes.reduce((s, t) => s + t.count, 0),
        byCategory: Object.fromEntries(
          Object.entries(byCategory).map(([k, v]) => [k, { label: PENALTY_CATEGORIES[k], count: v.count, amount: round2(v.amount) }])
        ),
        byMarketplace: Object.fromEntries(MPS.filter(mpOk).map((mp) => [mp, round2(byMp[mp])])),
        compensationTotal: round2(compensations.reduce((s, c) => s + c.amount, 0)),
        compensationCount: compensations.length,
        underpaidCount: underpaid.length,
        underpaidShortfall: round2(underpaid.reduce((s, c) => s + c.shortfall, 0)),
        dimensionIssuesCount: dimensionIssues.length,
        unpaidCount: unpaid.length,
        unpaidAmount: round2(unpaid.reduce((s, u) => s + u.amount, 0)),
      },
      penaltyTypes,
      penaltyProducts,
      compensations,
      dimensionIssues: dimensionIssues.map(withName),
      mpLogisticsMedian: Object.fromEntries(Object.entries(mpLogisticsMedian).map(([k, v]) => [k, v != null ? round2(v) : null])),
      payoutLag,
      unpaid: unpaid.slice(0, 500).map(withName),
    };
  }
}

export default new PenaltiesAnalyticsService();
