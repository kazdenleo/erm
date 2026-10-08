/**
 * Неликвиды и замороженные деньги.
 *
 * Остаток: свои склады + FBO (последний полный снапшот каждого МП), по себестоимости.
 * Неликвид — нет продаж N дней при остатке. Излишек — остаток сверх продаж на горизонт.
 * Рекомендация сравнивает стоимость удержания излишка (хранение на FBO + стоимость капитала)
 * с вывозом с FBO и со скидкой.
 */

import { query } from '../config/database.js';
import { sqlOzonSkuMapCte } from '../utils/offerArticleKey.js';
import {
  SALE_LINE,
  SQL_LINE_PRODUCT_ID,
  sqlOzonNameMapCte,
  lineProductJoins,
  sqlReportLinesUnion,
} from '../utils/marketplaceReportLineSql.js';
import {
  requireAnalyticsProfile,
  todayYmdMoscow,
  addDaysYmd,
  daysInclusive,
  round2,
  toNum,
  MP_LABELS,
} from '../utils/analyticsCommon.js';
import { loadFboDailyStock } from '../utils/stockAvailability.js';
import { sqlOrderOfferMapCte, sqlOrderOfferJoin, sqlOrderProductId } from '../utils/orderProductSql.js';
import logger from '../utils/logger.js';

const MPS = ['ozon', 'wb', 'ym'];

export const DEAD_STOCK_DEFAULTS = {
  noSalesDays: 60,
  horizonDays: 90,
  storagePerLiterDay: 0.1,
  removalPerUnit: 50,
  capitalRatePercent: 20,
};

const RECOMMENDATIONS = {
  remove_fbo: { label: 'Вывезти с FBO', severity: 'high' },
  discount: { label: 'Снизить цену', severity: 'high' },
  keep: { label: 'Оставить', severity: 'low' },
};

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

class DeadStockAnalyticsService {
  async getDeadStock({
    profileId,
    noSalesDays = DEAD_STOCK_DEFAULTS.noSalesDays,
    horizonDays = DEAD_STOCK_DEFAULTS.horizonDays,
    storagePerLiterDay = DEAD_STOCK_DEFAULTS.storagePerLiterDay,
    removalPerUnit = DEAD_STOCK_DEFAULTS.removalPerUnit,
    capitalRatePercent = DEAD_STOCK_DEFAULTS.capitalRatePercent,
    mode = 'all',
  } = {}) {
    const pid = requireAnalyticsProfile(profileId);
    const n = Math.round(clamp(noSalesDays, 7, 730, DEAD_STOCK_DEFAULTS.noSalesDays));
    const horizon = Math.round(clamp(horizonDays, 7, 365, DEAD_STOCK_DEFAULTS.horizonDays));
    const storageRate = clamp(storagePerLiterDay, 0, 100, DEAD_STOCK_DEFAULTS.storagePerLiterDay);
    const removal = clamp(removalPerUnit, 0, 100000, DEAD_STOCK_DEFAULTS.removalPerUnit);
    const capitalRate = clamp(capitalRatePercent, 0, 200, DEAD_STOCK_DEFAULTS.capitalRatePercent) / 100;
    const today = todayYmdMoscow();
    const salesFrom = addDaysYmd(today, -(Math.max(n, horizon) - 1));
    const lastNFrom = addDaysYmd(today, -(n - 1));
    const horizonFrom = addDaysYmd(today, -(horizon - 1));

    const productsSql = `
      SELECT p.id, p.name, p.sku, COALESCE(p.cost, 0) AS cost, COALESCE(p.price, 0) AS price,
             CASE WHEN p.length > 0 AND p.width > 0 AND p.height > 0
                  THEN p.length::numeric * p.width * p.height / 1000000
                  ELSE COALESCE(p.volume, 0) END AS volume_l,
             COALESCE(own.q, 0)::int AS own_qty
        FROM products p
        LEFT JOIN (
          SELECT pws.product_id, SUM(GREATEST(pws.quantity, 0))::int AS q
            FROM product_warehouse_stock pws
            JOIN warehouses w ON w.id = pws.warehouse_id AND w.type <> 'supplier'
           GROUP BY 1
        ) own ON own.product_id = p.id
       WHERE p.profile_id = $1
         AND NOT EXISTS (SELECT 1 FROM kit_components kc WHERE kc.kit_product_id = p.id)`;

    const fbsSalesSql = `
      WITH ${sqlOrderOfferMapCte()}
      SELECT ${sqlOrderProductId('o')} AS product_id,
             SUM(GREATEST(COALESCE(o.quantity, 1), 1)) FILTER (WHERE o.created_at >= ($3::date)::timestamp AT TIME ZONE 'Europe/Moscow')::numeric AS qty_n,
             SUM(GREATEST(COALESCE(o.quantity, 1), 1)) FILTER (WHERE o.created_at >= ($4::date)::timestamp AT TIME ZONE 'Europe/Moscow')::numeric AS qty_h,
             SUM(GREATEST(COALESCE(o.quantity, 1), 1) * COALESCE(o.price, 0))::numeric AS amount,
             SUM(GREATEST(COALESCE(o.quantity, 1), 1))::numeric AS qty_all,
             to_char(MAX(o.created_at) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS last_sale
        FROM orders o
        ${sqlOrderOfferJoin('o')}
       WHERE o.profile_id = $1 AND ${sqlOrderProductId('o')} IS NOT NULL
         AND LOWER(TRIM(COALESCE(o.status, ''))) <> 'cancelled'
         AND o.created_at >= ($2::date)::timestamp AT TIME ZONE 'Europe/Moscow'
       GROUP BY 1`;

    const lastSaleSql = `
      WITH ${sqlOrderOfferMapCte()}
      SELECT ${sqlOrderProductId('o')} AS product_id,
             to_char(MAX(o.created_at) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS last_sale
        FROM orders o
        ${sqlOrderOfferJoin('o')}
       WHERE o.profile_id = $1 AND ${sqlOrderProductId('o')} IS NOT NULL
         AND LOWER(TRIM(COALESCE(o.status, ''))) <> 'cancelled'
       GROUP BY 1`;

    const fboSalesSql = `
      WITH ${sqlOzonSkuMapCte()},
      ${sqlOzonNameMapCte()}
      SELECT ${SQL_LINE_PRODUCT_ID} AS product_id,
             SUM(GREATEST(l.quantity, 0)) FILTER (WHERE l.operation_date >= $3::date)::numeric AS qty_n,
             SUM(GREATEST(l.quantity, 0)) FILTER (WHERE l.operation_date >= $4::date)::numeric AS qty_h,
             SUM(l.retail_amount)::numeric AS amount,
             SUM(GREATEST(l.quantity, 0))::numeric AS qty_all,
             to_char(MAX(l.operation_date), 'YYYY-MM-DD') AS last_sale
        FROM ${sqlReportLinesUnion('all', "AND r.operation_date >= ($2::date - INTERVAL '365 days')")} l
        ${lineProductJoins()}
       WHERE ${SALE_LINE} AND ${SQL_LINE_PRODUCT_ID} IS NOT NULL
       GROUP BY 1`;

    const [productsRes, fbsRes, lastSaleRes, fboSalesRes, fbo, kitRes] = await Promise.all([
      query(productsSql, [pid]),
      query(fbsSalesSql, [pid, salesFrom, lastNFrom, horizonFrom]),
      query(lastSaleSql, [pid]),
      query(fboSalesSql, [pid, salesFrom, lastNFrom, horizonFrom]),
      loadFboDailyStock({ profileId: pid, fromYmd: addDaysYmd(today, -30), toYmd: today, lookbackDays: 0 }).catch((e) => {
        logger.warn('[DeadStock] FBO snapshots failed', e?.message || e);
        return null;
      }),
      query(
        `SELECT kc.kit_product_id, kc.component_product_id, GREATEST(COALESCE(kc.quantity, 1), 1)::numeric AS qty
           FROM kit_components kc JOIN products p ON p.id = kc.kit_product_id AND p.profile_id = $1`,
        [pid]
      ),
    ]);

    // Продажа комплекта = продажа комплектующих (иначе они выглядят неликвидом)
    const kitParts = new Map();
    for (const r of kitRes.rows || []) {
      const kitId = Number(r.kit_product_id);
      if (!kitParts.has(kitId)) kitParts.set(kitId, []);
      kitParts.get(kitId).push({ id: Number(r.component_product_id), qty: Number(r.qty) || 1 });
    }
    const explode = (rows) => {
      const out = [];
      for (const r of rows || []) {
        const parts = kitParts.get(Number(r.product_id));
        if (!parts) {
          out.push(r);
          continue;
        }
        for (const part of parts) {
          out.push({
            ...r,
            product_id: part.id,
            qty_n: (Number(r.qty_n) || 0) * part.qty,
            qty_h: (Number(r.qty_h) || 0) * part.qty,
            qty_all: (Number(r.qty_all) || 0) * part.qty,
            amount: 0,
          });
        }
      }
      return out;
    };
    fbsRes.rows = explode(fbsRes.rows);
    fboSalesRes.rows = explode(fboSalesRes.rows);
    lastSaleRes.rows = explode(lastSaleRes.rows);

    // Продажи из финотчётов за 365 дн. (FBO и FBS), чтобы «последняя продажа» не терялась
    const sales = new Map();
    const getSales = (id) => {
      if (!sales.has(id)) sales.set(id, { qtyN: 0, qtyH: 0, amount: 0, qtyAll: 0, lastSale: null, fbsQtyN: 0, fbsQtyH: 0 });
      return sales.get(id);
    };
    for (const r of fbsRes.rows || []) {
      const s = getSales(Number(r.product_id));
      s.fbsQtyN += Number(r.qty_n) || 0;
      s.fbsQtyH += Number(r.qty_h) || 0;
      s.amount += Number(r.amount) || 0;
      s.qtyAll += Number(r.qty_all) || 0;
    }
    for (const r of lastSaleRes.rows || []) {
      const s = getSales(Number(r.product_id));
      if (r.last_sale && (!s.lastSale || r.last_sale > s.lastSale)) s.lastSale = r.last_sale;
    }
    // Финотчёт содержит и FBS-продажи (по дате доставки) — берём максимум из заказов и отчёта, не сумму.
    const reportSales = new Map();
    for (const r of fboSalesRes.rows || []) {
      const id = Number(r.product_id);
      const rep = reportSales.get(id) || { qtyN: 0, qtyH: 0, amount: 0, qtyAll: 0 };
      rep.qtyN += Number(r.qty_n) || 0;
      rep.qtyH += Number(r.qty_h) || 0;
      rep.amount += Number(r.amount) || 0;
      rep.qtyAll += Number(r.qty_all) || 0;
      reportSales.set(id, rep);
      const s = getSales(id);
      if (r.last_sale && (!s.lastSale || r.last_sale > s.lastSale)) s.lastSale = r.last_sale;
    }
    for (const [id, s] of sales.entries()) {
      const rep = reportSales.get(id);
      s.qtyN = Math.max(s.fbsQtyN, rep?.qtyN || 0);
      s.qtyH = Math.max(s.fbsQtyH, rep?.qtyH || 0);
      if (!s.amount && rep?.amount > 0) {
        s.amount = rep.amount;
        s.qtyAll = rep.qtyAll;
      }
    }

    const fboQty = new Map();
    const fboSnapshotDay = {};
    if (fbo) {
      for (const [mp, latest] of fbo.latest.entries()) {
        if (!MPS.includes(mp)) continue;
        fboSnapshotDay[mp] = latest.day;
        for (const [productId, qty] of latest.qtyByProduct.entries()) {
          if (qty <= 0) continue;
          if (!fboQty.has(productId)) fboQty.set(productId, {});
          fboQty.get(productId)[mp] = qty;
        }
      }
    }

    const items = [];
    const summary = {
      totalStockCost: 0,
      ownStockCost: 0,
      fboStockCost: 0,
      deadCount: 0,
      deadCost: 0,
      excessCount: 0,
      excessCost: 0,
      fboStorageMonth: 0,
      holdCostHorizon: 0,
      byRecommendation: { remove_fbo: 0, discount: 0, keep: 0 },
    };

    for (const p of productsRes.rows || []) {
      const productId = Number(p.id);
      const own = Number(p.own_qty) || 0;
      const fboByMp = fboQty.get(productId) || {};
      const fboTotal = Object.values(fboByMp).reduce((a, b) => a + b, 0);
      const total = own + fboTotal;
      if (total <= 0) continue;

      const cost = toNum(p.cost);
      const volumeL = toNum(p.volume_l);
      const s = sales.get(productId) || { qtyN: 0, qtyH: 0, amount: 0, qtyAll: 0, lastSale: null };
      const avgPrice = s.qtyAll > 0 && s.amount > 0 ? s.amount / s.qtyAll : toNum(p.price);
      const rate = s.qtyH / horizon;
      const coverageDays = rate > 0 ? total / rate : null;
      const dead = s.qtyN <= 0;
      const needed = rate * horizon;
      const excessUnits = Math.max(0, total - needed);
      totalCostAdd(summary, own * cost, fboTotal * cost);
      if (!dead && excessUnits < 1) continue;

      // Излишек уходит сначала с FBO (там за него платим хранение), затем со своего склада
      const excessFbo = Math.min(fboTotal, excessUnits);
      const storagePerDay = fboTotal * volumeL * storageRate;
      const storageExcessHorizon = excessFbo * volumeL * storageRate * horizon;
      const removalCost = excessFbo * removal;
      const capitalCost = excessUnits * cost * capitalRate * (horizon / 365);
      const holdCost = storageExcessHorizon + capitalCost;
      const holdPerUnit = excessUnits > 0 ? holdCost / excessUnits : 0;
      const breakEvenDiscountPct = avgPrice > 0 ? Math.min(100, (holdPerUnit / avgPrice) * 100) : null;

      let rec = 'keep';
      if (excessFbo > 0 && storageExcessHorizon > removalCost) rec = 'remove_fbo';
      else if (dead || (breakEvenDiscountPct != null && breakEvenDiscountPct >= 5)) rec = 'discount';

      const hint =
        rec === 'remove_fbo'
          ? `Хранение излишка на FBO за ${horizon} дн. ≈ ${Math.round(storageExcessHorizon)} ₽, вывоз ≈ ${Math.round(removalCost)} ₽.`
          : rec === 'discount'
            ? dead
              ? `Нет продаж ${n} дн. — проверьте цену, карточку и рекламу. Удержание ≈ ${Math.round(holdCost)} ₽ за ${horizon} дн.${
                  breakEvenDiscountPct >= 1 ? `; скидка до ${round2(breakEvenDiscountPct)}% окупается` : ''
                }.`
              : `Удержание ≈ ${Math.round(holdPerUnit)} ₽/шт. за ${horizon} дн. — скидка до ${round2(breakEvenDiscountPct || 0)}% выгоднее, чем ждать.`
            : `Удержание излишка ≈ ${Math.round(holdCost)} ₽ за ${horizon} дн. — дешевле, чем скидка или вывоз.`;

      const lastSale = s.lastSale;
      const item = {
        productId,
        productName: p.name || '—',
        productSku: p.sku || '',
        cost: round2(cost),
        avgPrice: round2(avgPrice),
        volumeL: round2(volumeL),
        ownQty: own,
        fboQty: fboByMp,
        fboTotal,
        totalQty: total,
        stockCost: round2(total * cost),
        lastSaleDate: lastSale,
        daysSinceSale: lastSale ? daysInclusive(lastSale, today) - 1 : null,
        salesLastN: Math.round(s.qtyN),
        salesHorizon: Math.round(s.qtyH),
        ratePerDay: round2(rate),
        coverageDays: coverageDays != null ? Math.round(coverageDays) : null,
        dead,
        excessUnits: Math.round(excessUnits),
        excessCost: round2(excessUnits * cost),
        fboStoragePerMonth: round2(storagePerDay * 30),
        storageExcessHorizon: round2(storageExcessHorizon),
        removalCost: round2(removalCost),
        capitalCost: round2(capitalCost),
        holdCost: round2(holdCost),
        breakEvenDiscountPct: breakEvenDiscountPct != null ? round2(breakEvenDiscountPct) : null,
        recommendation: { code: rec, ...RECOMMENDATIONS[rec], hint },
      };
      if (mode === 'dead' && !dead) continue;
      if (mode === 'excess' && dead) continue;
      items.push(item);

      if (dead) {
        summary.deadCount += 1;
        summary.deadCost += item.stockCost;
      } else {
        summary.excessCount += 1;
      }
      summary.excessCost += item.excessCost;
      summary.fboStorageMonth += item.fboStoragePerMonth;
      summary.holdCostHorizon += item.holdCost;
      summary.byRecommendation[rec] += 1;
    }

    items.sort((a, b) => Number(b.dead) - Number(a.dead) || b.excessCost - a.excessCost);

    for (const k of ['totalStockCost', 'ownStockCost', 'fboStockCost', 'deadCost', 'excessCost', 'fboStorageMonth', 'holdCostHorizon']) {
      summary[k] = round2(summary[k]);
    }

    return {
      params: {
        noSalesDays: n,
        horizonDays: horizon,
        storagePerLiterDay: storageRate,
        removalPerUnit: removal,
        capitalRatePercent: round2(capitalRate * 100),
        mode,
      },
      today,
      fboSnapshotDay,
      marketplaceLabels: MP_LABELS,
      summary,
      items,
    };
  }
}

function totalCostAdd(summary, ownCost, fboCost) {
  summary.ownStockCost += ownCost;
  summary.fboStockCost += fboCost;
  summary.totalStockCost += ownCost + fboCost;
}

export default new DeadStockAnalyticsService();
