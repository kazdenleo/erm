/**
 * Упущенная выручка: продажи, потерянные из-за отсутствия товара.
 *
 * FBS: дни без своего остатка (и без остатка поставщиков, если он известен) × темп продаж товара
 * на МП в дни наличия. FBO: дни с нулевым остатком на складе МП (для товаров, которые на FBO
 * этого МП вообще лежат) × темп FBO-продаж в дни наличия.
 * Выручка — по средней цене продажи, прибыль — по марже товара из финотчётов за 90 дней.
 */

import { query } from '../config/database.js';
import { sqlOzonSkuMapCte } from '../utils/offerArticleKey.js';
import {
  SALE_LINE,
  RETURN_SALE_LINE,
  SQL_MP_NORM,
  SQL_LINE_PRODUCT_ID,
  SQL_NET_TRANSFER,
  sqlOzonNameMapCte,
  lineProductJoins,
  sqlReportLinesUnion,
} from '../utils/marketplaceReportLineSql.js';
import {
  requireAnalyticsProfile,
  resolvePeriod,
  listDaysYmd,
  addDaysYmd,
  todayYmdMoscow,
  normalizeMp,
  normalizeScheme,
  mpDbVariants,
  normMpCode,
  round2,
  MP_LABELS,
} from '../utils/analyticsCommon.js';
import { loadOwnStockOosDays, loadFboDailyStock } from '../utils/stockAvailability.js';
import { sqlOrderOfferMapCte, sqlOrderOfferJoin, sqlOrderProductId } from '../utils/orderProductSql.js';
import logger from '../utils/logger.js';

const RATE_LOOKBACK_DAYS = 56;
const MIN_IN_STOCK_SHARE = 0.3;
const MARGIN_LOOKBACK_DAYS = 90;
const MPS = ['ozon', 'wb', 'ym'];

const mskStart = (param) => `(${param}::date)::timestamp AT TIME ZONE 'Europe/Moscow'`;

function pushDay(map, pid, day, qty) {
  if (!map.has(pid)) map.set(pid, new Map());
  const m = map.get(pid);
  m.set(day, (m.get(day) || 0) + qty);
}

class LostRevenueAnalyticsService {
  /**
   * Снимок наличия за сегодня (МСК): свои склады + поставщики.
   * Пишем товары с остатком или с заказами за 180 дней — отсутствие строки = «нет данных».
   */
  async snapshotStockDaily({ profileId = null, day = null } = {}) {
    const ymd = day || todayYmdMoscow();
    const params = [ymd];
    let profileClause = '';
    if (profileId) {
      params.push(Number(profileId));
      profileClause = `AND p.profile_id = $${params.length}`;
    }
    const r = await query(
      `INSERT INTO product_stock_daily (profile_id, day, product_id, own_qty, supplier_qty)
       SELECT p.profile_id, $1::date, p.id, COALESCE(own.q, 0), COALESCE(sup.q, 0)
         FROM products p
         LEFT JOIN (
           SELECT pws.product_id, SUM(GREATEST(pws.quantity, 0))::int AS q
             FROM product_warehouse_stock pws
             JOIN warehouses w ON w.id = pws.warehouse_id AND w.type <> 'supplier'
            GROUP BY 1
         ) own ON own.product_id = p.id
         LEFT JOIN (
           SELECT product_id, SUM(GREATEST(stock, 0))::int AS q FROM supplier_stocks GROUP BY 1
         ) sup ON sup.product_id = p.id
        WHERE p.profile_id IS NOT NULL ${profileClause}
          AND (
            COALESCE(own.q, 0) > 0
            OR COALESCE(sup.q, 0) > 0
            OR EXISTS (
              SELECT 1 FROM orders o
               WHERE o.product_id = p.id AND o.created_at >= NOW() - INTERVAL '180 days'
            )
          )
       ON CONFLICT (profile_id, day, product_id)
       DO UPDATE SET own_qty = EXCLUDED.own_qty, supplier_qty = EXCLUDED.supplier_qty`,
      params
    );
    return { day: ymd, rows: r.rowCount || 0 };
  }

  async hasStockSnapshotForToday() {
    const r = await query('SELECT 1 FROM product_stock_daily WHERE day = $1::date LIMIT 1', [todayYmdMoscow()]);
    return Boolean(r.rows?.length);
  }

  async getLostRevenue({ profileId, dateFrom, dateTo, marketplace = 'all', scheme = 'all', limit = 500 } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const { fromYmd, toYmd, days: periodDays } = resolvePeriod(dateFrom, dateTo, 28);
    const mpFilter = normalizeMp(marketplace);
    const schemeNorm = normalizeScheme(scheme);
    const rateFrom = addDaysYmd(fromYmd, -RATE_LOOKBACK_DAYS);
    const rateDays = listDaysYmd(rateFrom, toYmd);
    const periodDayList = listDaysYmd(fromYmd, toYmd);
    const marginFrom = addDaysYmd(toYmd, -(MARGIN_LOOKBACK_DAYS - 1));
    const mpVariants = mpDbVariants(mpFilter);

    const fbsOrdersSql = `
      WITH ${sqlOrderOfferMapCte()}
      SELECT ${sqlOrderProductId('o')} AS product_id,
             LOWER(TRIM(o.marketplace)) AS mp,
             to_char(o.created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS d,
             SUM(GREATEST(COALESCE(o.quantity, 1), 1))::numeric AS qty,
             SUM(GREATEST(COALESCE(o.quantity, 1), 1) * COALESCE(o.price, 0))::numeric AS amount
        FROM orders o
        ${sqlOrderOfferJoin('o')}
       WHERE o.profile_id = $1
         AND ${sqlOrderProductId('o')} IS NOT NULL
         AND LOWER(TRIM(COALESCE(o.status, ''))) <> 'cancelled'
         AND o.created_at >= ${mskStart('$2')}
         AND o.created_at < ${mskStart('$3')} + INTERVAL '1 day'
         ${mpVariants ? 'AND LOWER(TRIM(o.marketplace)) = ANY($4::text[])' : ''}
       GROUP BY 1, 2, 3`;

    const fboSalesSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT ${SQL_LINE_PRODUCT_ID} AS product_id, ${SQL_MP_NORM} AS mp,
             to_char(l.operation_date, 'YYYY-MM-DD') AS d,
             SUM(GREATEST(l.quantity, 0))::numeric AS qty,
             SUM(l.retail_amount)::numeric AS amount
        FROM ${sqlReportLinesUnion('fbo', 'AND r.operation_date >= $2::date AND r.operation_date <= $3::date')} l
        ${lineProductJoins()}
       WHERE ${SALE_LINE} AND ${SQL_LINE_PRODUCT_ID} IS NOT NULL
       GROUP BY 1, 2, 3`;

    const marginSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT ${SQL_LINE_PRODUCT_ID} AS product_id, ${SQL_MP_NORM} AS mp,
             SUM(CASE WHEN ${SALE_LINE} THEN l.retail_amount ELSE 0 END)::numeric AS sold_amount,
             SUM(CASE WHEN ${SALE_LINE} THEN GREATEST(l.quantity, 0) ELSE 0 END)::numeric AS sold_qty,
             SUM(${SQL_NET_TRANSFER})::numeric AS net_transfer,
             SUM(CASE
               WHEN ${SALE_LINE}
                 THEN GREATEST(l.quantity, 0) * (COALESCE(p.cost, 0) + COALESCE(p.additional_expenses, 0))
               WHEN ${RETURN_SALE_LINE}
                 THEN -GREATEST(ABS(l.quantity), 1) * (COALESCE(p.cost, 0) + COALESCE(p.additional_expenses, 0))
               ELSE 0 END)::numeric AS cost
        FROM ${sqlReportLinesUnion('all', 'AND r.operation_date >= $2::date AND r.operation_date <= $3::date')} l
        ${lineProductJoins()}
       GROUP BY 1, 2`;

    const fbsParams = [pid, rateFrom, toYmd];
    if (mpVariants) fbsParams.push(mpVariants);

    const wantFbs = schemeNorm !== 'fbo';
    const wantFbo = schemeNorm !== 'fbs';

    const [fbsRes, fboRes, marginRes, fbo] = await Promise.all([
      wantFbs ? query(fbsOrdersSql, fbsParams) : { rows: [] },
      wantFbo ? query(fboSalesSql, [pid, rateFrom, toYmd]) : { rows: [] },
      query(marginSql, [pid, marginFrom, toYmd]),
      wantFbo
        ? loadFboDailyStock({ profileId: pid, fromYmd: rateFrom, toYmd, mpValues: mpFilter === 'all' ? null : [mpFilter] }).catch(
            (e) => {
              logger.warn('[LostRevenue] FBO snapshots failed', e?.message || e);
              return null;
            }
          )
        : null,
    ]);

    // Маржа (валовая прибыль / выручка) по товару и МП, запасной вариант — по МП
    const margin = new Map();
    const mpMargin = new Map();
    for (const r of marginRes.rows || []) {
      const mp = normMpCode(r.mp);
      const amount = Number(r.sold_amount) || 0;
      const gross = (Number(r.net_transfer) || 0) - (Number(r.cost) || 0);
      if (r.product_id != null && amount > 0) margin.set(`${mp}|${Number(r.product_id)}`, gross / amount);
      const agg = mpMargin.get(mp) || { amount: 0, gross: 0 };
      agg.amount += amount;
      agg.gross += gross;
      mpMargin.set(mp, agg);
    }
    const marginFor = (mp, productId) => {
      const own = margin.get(`${mp}|${productId}`);
      if (own != null && Number.isFinite(own)) return Math.max(-1, Math.min(1, own));
      const agg = mpMargin.get(mp);
      return agg && agg.amount > 0 ? Math.max(-1, Math.min(1, agg.gross / agg.amount)) : 0;
    };

    // Продажи FBS по товару × МП × дню
    const fbsSales = new Map();
    const fbsSalesByProductDay = new Map();
    for (const r of fbsRes.rows || []) {
      const mp = normMpCode(r.mp);
      if (!MPS.includes(mp)) continue;
      const productId = Number(r.product_id);
      const key = `${mp}|${productId}`;
      const agg = fbsSales.get(key) || { mp, productId, qty: 0, amount: 0 };
      agg.qty += Number(r.qty) || 0;
      agg.amount += Number(r.amount) || 0;
      fbsSales.set(key, agg);
      pushDay(fbsSalesByProductDay, productId, r.d, Number(r.qty) || 0);
    }

    const fboSales = new Map();
    for (const r of fboRes.rows || []) {
      const mp = normMpCode(r.mp);
      if (mpFilter !== 'all' && mp !== mpFilter) continue;
      const productId = Number(r.product_id);
      const key = `${mp}|${productId}`;
      const agg = fboSales.get(key) || { mp, productId, qty: 0, amount: 0, days: new Set() };
      agg.qty += Number(r.qty) || 0;
      agg.amount += Number(r.amount) || 0;
      if ((Number(r.qty) || 0) > 0) agg.days.add(r.d);
      fboSales.set(key, agg);
    }

    const fbsProductIds = [...new Set([...fbsSales.values()].map((s) => s.productId))];
    const ownOos = wantFbs
      ? await loadOwnStockOosDays({
          profileId: pid,
          productIds: fbsProductIds,
          fromYmd: rateFrom,
          toYmd,
          salesByProductDay: fbsSalesByProductDay,
        })
      : new Map();

    let liveStock = new Map();
    if (fbsProductIds.length) {
      const live = await query(
        `SELECT p.id,
                COALESCE((SELECT SUM(GREATEST(pws.quantity, 0)) FROM product_warehouse_stock pws
                           JOIN warehouses w ON w.id = pws.warehouse_id AND w.type <> 'supplier'
                          WHERE pws.product_id = p.id), 0)::int
              + COALESCE((SELECT SUM(GREATEST(ss.stock, 0)) FROM supplier_stocks ss WHERE ss.product_id = p.id), 0)::int AS q
           FROM products p WHERE p.id = ANY($1::bigint[])`,
        [fbsProductIds]
      );
      liveStock = new Map((live.rows || []).map((r) => [Number(r.id), Number(r.q) || 0]));
    }

    const items = [];
    const byDay = new Map(periodDayList.map((d) => [d, { day: d, fbs: 0, fbo: 0 }]));

    const addItem = ({ scheme, mp, productId, salesQty, salesAmount, oosSet, knownDays, oosNow, supplierBacked }) => {
      const windowDays = knownDays ? knownDays.length : rateDays.length;
      const oosInWindow = (knownDays || rateDays).filter((d) => oosSet.has(d)).length;
      const inStockDays = windowDays - oosInWindow;
      if (salesQty <= 0 || windowDays <= 0) return;
      // Почти всё окно без товара — темп продаж оценить не по чему.
      const insufficientData = inStockDays < windowDays * MIN_IN_STOCK_SHARE;
      const rate = insufficientData ? 0 : salesQty / inStockDays;
      const oosPeriodDays = periodDayList.filter((d) => oosSet.has(d));
      if (!oosPeriodDays.length && !oosNow) return;
      const avgPrice = salesAmount / salesQty;
      const m = marginFor(mp, productId);
      const lostUnits = rate * oosPeriodDays.length;
      const lostRevenue = lostUnits * avgPrice;
      if (rate > 0) for (const d of oosPeriodDays) byDay.get(d)[scheme] += rate * avgPrice;
      items.push({
        productId,
        marketplace: mp,
        scheme,
        oosDays: oosPeriodDays.length,
        periodDays,
        inStockDays,
        rateWindowDays: windowDays,
        insufficientData,
        supplierBacked: Boolean(supplierBacked),
        ratePerDay: round2(rate),
        avgPrice: round2(avgPrice),
        marginPercent: round2(m * 100),
        lostUnits: round2(lostUnits),
        lostRevenue: round2(lostRevenue),
        lostProfit: round2(lostRevenue * m),
        oosNow: Boolean(oosNow),
        lastOosDay: oosPeriodDays.length ? oosPeriodDays[oosPeriodDays.length - 1] : null,
      });
    };

    for (const s of fbsSales.values()) {
      const info = ownOos.get(s.productId);
      if (!info || info.isKit) continue;
      addItem({
        scheme: 'fbs',
        mp: s.mp,
        productId: s.productId,
        salesQty: s.qty,
        salesAmount: s.amount,
        oosSet: info.oosDays,
        knownDays: null,
        oosNow: !info.supplierBacked && (liveStock.get(s.productId) ?? 0) <= 0,
        supplierBacked: info.supplierBacked,
      });
    }

    if (fbo) {
      for (const [key, perDay] of fbo.byKey.entries()) {
        const [mp, pidStr] = key.split('|');
        if (!MPS.includes(mp)) continue;
        const productId = Number(pidStr);
        const everStocked = [...perDay.values()].some((q) => q > 0);
        if (!everStocked) continue;
        const sales = fboSales.get(key);
        if (!sales) continue;
        const knownDays = rateDays.filter((d) => perDay.has(d));
        if (!knownDays.length) continue;
        const oosSet = new Set(knownDays.filter((d) => (perDay.get(d) || 0) <= 0));
        // Продажи шли в большинство «пустых» дней — снапшот не сопоставлен с товаром, а не нехватка.
        const soldOnEmpty = [...oosSet].filter((d) => sales.days.has(d)).length;
        if (oosSet.size >= 3 && soldOnEmpty >= oosSet.size * 0.5) continue;
        const latest = fbo.latest.get(mp);
        addItem({
          scheme: 'fbo',
          mp,
          productId,
          salesQty: sales.qty,
          salesAmount: sales.amount,
          oosSet,
          knownDays,
          oosNow: latest ? (latest.qtyByProduct.get(productId) ?? 0) <= 0 : false,
        });
      }
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

    items.sort((a, b) => b.lostRevenue - a.lostRevenue || (b.oosNow ? 1 : 0) - (a.oosNow ? 1 : 0));

    const summary = {
      lostUnits: 0,
      lostRevenue: 0,
      lostProfit: 0,
      fbsLostRevenue: 0,
      fboLostRevenue: 0,
      productsAffected: new Set(),
      oosNowCount: 0,
      byMarketplace: Object.fromEntries(MPS.map((mp) => [mp, { label: MP_LABELS[mp], lostRevenue: 0, lostProfit: 0 }])),
    };
    for (const it of items) {
      summary.lostUnits += it.lostUnits;
      summary.lostRevenue += it.lostRevenue;
      summary.lostProfit += it.lostProfit;
      if (it.scheme === 'fbs') summary.fbsLostRevenue += it.lostRevenue;
      else summary.fboLostRevenue += it.lostRevenue;
      if (it.lostRevenue > 0) summary.productsAffected.add(it.productId);
      if (it.oosNow) summary.oosNowCount += 1;
      const bm = summary.byMarketplace[it.marketplace];
      if (bm) {
        bm.lostRevenue += it.lostRevenue;
        bm.lostProfit += it.lostProfit;
      }
    }
    for (const bm of Object.values(summary.byMarketplace)) {
      bm.lostRevenue = round2(bm.lostRevenue);
      bm.lostProfit = round2(bm.lostProfit);
    }

    const stockHistory = await query(
      `SELECT to_char(MIN(day), 'YYYY-MM-DD') AS d FROM product_stock_daily WHERE profile_id = $1`,
      [pid]
    );

    const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
    return {
      period: { dateFrom: fromYmd, dateTo: toYmd, days: periodDays },
      rateWindow: { dateFrom: rateFrom, dateTo: toYmd, days: rateDays.length },
      filters: { marketplace: mpFilter, scheme: schemeNorm },
      supplierStockTrackedSince: stockHistory.rows?.[0]?.d || null,
      fboSnapshotDays: fbo
        ? Object.fromEntries([...fbo.snapshotDays.entries()].map(([mp, set]) => [mp, [...set].filter((d) => d >= fromYmd).length]))
        : {},
      summary: {
        lostUnits: round2(summary.lostUnits),
        lostRevenue: round2(summary.lostRevenue),
        lostProfit: round2(summary.lostProfit),
        fbsLostRevenue: round2(summary.fbsLostRevenue),
        fboLostRevenue: round2(summary.fboLostRevenue),
        productsAffected: summary.productsAffected.size,
        oosNowCount: summary.oosNowCount,
        byMarketplace: summary.byMarketplace,
      },
      byDay: [...byDay.values()].map((d) => ({ day: d.day, fbs: round2(d.fbs), fbo: round2(d.fbo), total: round2(d.fbs + d.fbo) })),
      items: items.slice(0, lim),
      totalItems: items.length,
    };
  }
}

export default new LostRevenueAnalyticsService();
