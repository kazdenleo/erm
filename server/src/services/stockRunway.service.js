/**
 * «Пора пополнить запасы»: на сколько дней хватит свободного остатка на наших складах.
 * Расход = заказы FBS и частные + товары в поставках FBO за период (комплекты разложены на комплектующие).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { batchWarehouseScopedIncomingMap } from './kitStock.service.js';
import { batchComponentQtyInKitsOnWarehouse, batchWarehouseReservedMap } from './procurementForecast.service.js';
import { sqlOrderOfferMapCte, sqlOrderOfferJoin, sqlOrderProductId } from '../utils/orderProductSql.js';
import { orderMultipleFromKits, toOrderRounded } from '../utils/stockRunwayMath.js';

const DAY_MS = 86400000;
const CRITICAL_DAYS = 3;
const CANCELLED_STATUSES = ['cancelled', 'canceled', 'заказ удалён'];

export const RUNWAY_URGENCY = ['out', 'critical', 'soon', 'ok'];

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function mskYmd(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(date);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function addPerWarehouse(map, warehouseIds, loader) {
  for (const wid of warehouseIds) {
    const part = await loader(wid);
    for (const [pid, qty] of part) map.set(pid, (map.get(pid) || 0) + (Number(qty) || 0));
  }
}

async function batchKitComponentQtys(productIds) {
  const map = new Map();
  const ids = [...new Set((productIds || []).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return map;
  const r = await query(
    `SELECT component_product_id, array_agg(DISTINCT GREATEST(COALESCE(quantity, 1), 1)::int) AS qtys
       FROM kit_components
      WHERE component_product_id = ANY($1::bigint[])
      GROUP BY 1`,
    [ids]
  );
  for (const row of r.rows || []) {
    map.set(Number(row.component_product_id), (row.qtys || []).map((q) => Number(q) || 1));
  }
  return map;
}

class StockRunwayService {
  /**
   * @param {object} p
   * @param {number} p.profileId
   * @param {number|null} [p.warehouseId] один склад; по умолчанию все наши склады профиля
   * @param {number} [p.periodDays] за сколько дней считать расход
   * @param {number} [p.alertDays] «скоро закончится» — запаса меньше стольких дней
   * @param {number} [p.coverDays] на сколько дней предлагать заказ
   */
  async getRunway({ profileId, warehouseId = null, periodDays = 10, alertDays = 2, coverDays = 5, limit = 1000 } = {}) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) throw httpError('Профиль не определён', 403);
    if (!repositoryFactory.isUsingPostgreSQL()) throw httpError('Доступно только с PostgreSQL', 501);

    const days = clampInt(periodDays, 7, 120, 10);
    const alert = clampInt(alertDays, 1, 120, 2);
    const cover = clampInt(coverDays, 1, 180, 5);
    // «Критично» строго раньше «Скоро», иначе при alertDays ≤ 3 вкладка «Скоро» пустеет
    const criticalDays = Math.min(CRITICAL_DAYS, Math.max(1, alert - 1));
    const lim = clampInt(limit, 1, 5000, 1000);

    const whRes = await query(
      `SELECT id, name, COALESCE(is_fbo_stock, false) AS is_fbo_stock
         FROM warehouses WHERE profile_id = $1 ORDER BY id`,
      [pid]
    );
    const allWarehouses = (whRes.rows || []).map((w) => ({
      id: Number(w.id),
      name: w.name,
      isFbo: Boolean(w.is_fbo_stock),
    }));
    const wantWh = warehouseId != null && warehouseId !== '' ? Number(warehouseId) : null;
    const scope = wantWh ? allWarehouses.filter((w) => w.id === wantWh) : allWarehouses;
    if (wantWh && !scope.length) throw httpError('Склад не найден', 404);
    const scopeIds = scope.map((w) => w.id);

    // Заказы FBS/частные уходят с обычных складов, поставки FBO — со склада списания поставки.
    const countOrders = !wantWh || scope.some((w) => !w.isFbo);
    const singleFboWh = wantWh && scope[0]?.isFbo ? wantWh : null;
    const countSupplies = !wantWh || scope[0]?.isFbo || allWarehouses.every((w) => !w.isFbo);

    const now = new Date();
    const to = now.toISOString();
    const from = new Date(now.getTime() - days * DAY_MS).toISOString();

    const demandRes = await query(
      `
      WITH ${sqlOrderOfferMapCte()},
      demand_raw AS (
        SELECT ${sqlOrderProductId('o')} AS product_id, 'orders' AS src,
               SUM(GREATEST(COALESCE(o.quantity, 1), 1))::numeric AS q
          FROM orders o
          ${sqlOrderOfferJoin('o')}
         WHERE $4::boolean
           AND o.profile_id = $1
           AND ${sqlOrderProductId('o')} IS NOT NULL
           AND o.created_at >= $2::timestamptz AND o.created_at < $3::timestamptz
           AND LOWER(TRIM(COALESCE(o.status, ''))) <> ALL($7::text[])
         GROUP BY 1
        UNION ALL
        SELECT i.product_id, 'fbo' AS src, SUM(i.quantity)::numeric AS q
          FROM fbo_supply_items i
          JOIN fbo_supplies s ON s.id = i.fbo_supply_id
         WHERE $5::boolean
           AND s.profile_id = $1
           AND i.product_id IS NOT NULL
           AND s.status <> 'return'
           AND s.created_at >= $2::timestamptz AND s.created_at < $3::timestamptz
           AND ($6::bigint IS NULL OR s.deduction_warehouse_id IS NULL OR s.deduction_warehouse_id = $6::bigint)
         GROUP BY i.product_id
      ),
      exploded AS (
        SELECT kc.component_product_id AS product_id, d.src,
               SUM(d.q * GREATEST(COALESCE(kc.quantity, 1), 1)) AS q
          FROM demand_raw d
          JOIN kit_components kc ON kc.kit_product_id = d.product_id
         GROUP BY 1, 2
        UNION ALL
        SELECT d.product_id, d.src, SUM(d.q)
          FROM demand_raw d
         WHERE NOT EXISTS (SELECT 1 FROM kit_components kc WHERE kc.kit_product_id = d.product_id)
         GROUP BY 1, 2
      )
      SELECT e.product_id,
             p.name, p.sku, p.supplier_id, s.name AS supplier_name,
             COALESCE(SUM(e.q) FILTER (WHERE e.src = 'orders'), 0)::numeric AS orders_qty,
             COALESCE(SUM(e.q) FILTER (WHERE e.src = 'fbo'), 0)::numeric AS fbo_qty,
             COALESCE((
               SELECT SUM(d.q) FROM demand_raw d WHERE d.product_id = e.product_id
             ), 0)::numeric AS direct_qty,
             COALESCE((SELECT SUM(pws.quantity) FROM product_warehouse_stock pws
                        WHERE pws.product_id = e.product_id AND pws.warehouse_id = ANY($8::bigint[])), 0)::int AS on_hand
        FROM exploded e
        JOIN products p ON p.id = e.product_id AND p.profile_id = $1
        LEFT JOIN suppliers s ON s.id = p.supplier_id
       GROUP BY e.product_id, p.name, p.sku, p.supplier_id, s.name
      `,
      [pid, from, to, countOrders, countSupplies, singleFboWh, CANCELLED_STATUSES, scopeIds]
    );

    const rows = demandRes.rows || [];
    const productIds = rows.map((r) => Number(r.product_id)).filter((n) => n > 0);

    const reserved = new Map();
    const inKits = new Map();
    const incoming = new Map();
    let kitQtys = new Map();
    if (productIds.length) {
      await addPerWarehouse(reserved, scopeIds, (wid) => batchWarehouseReservedMap(productIds, wid));
      await addPerWarehouse(inKits, scopeIds, (wid) => batchComponentQtyInKitsOnWarehouse(productIds, wid));
      await addPerWarehouse(incoming, scopeIds, (wid) =>
        batchWarehouseScopedIncomingMap(productIds, { warehouseId: wid, profileId: pid })
      );
      kitQtys = await batchKitComponentQtys(productIds);
    }

    const today = new Date(`${mskYmd(now)}T12:00:00Z`);
    const items = [];
    for (const r of rows) {
      const productId = Number(r.product_id);
      const ordersQty = Number(r.orders_qty) || 0;
      const fboQty = Number(r.fbo_qty) || 0;
      const dailyRate = (ordersQty + fboQty) / days;
      if (dailyRate <= 0) continue;

      const onHand = Math.max(0, Number(r.on_hand) || 0);
      const rsv = Math.max(0, Number(reserved.get(productId)) || 0);
      const kits = Math.max(0, Number(inKits.get(productId)) || 0);
      const inc = Math.max(0, Number(incoming.get(productId)) || 0);
      const available = Math.max(0, onHand - Math.min(rsv, onHand)) + kits;
      const daysLeft = available / dailyRate;
      const daysLeftWithIncoming = (available + inc) / dailyRate;

      let urgency = 'ok';
      if (available <= 0) urgency = 'out';
      else if (daysLeft <= criticalDays) urgency = 'critical';
      else if (daysLeft <= alert) urgency = 'soon';
      if (urgency === 'ok') continue;

      const orderMultiple = orderMultipleFromKits(Number(r.direct_qty) || 0, kitQtys.get(productId));
      const coverNeed = Math.ceil(dailyRate * cover);
      const toOrder = toOrderRounded({
        need: coverNeed,
        available,
        incoming: inc,
        orderMultiple,
      });

      const runOut = new Date(today.getTime() + Math.floor(daysLeft) * DAY_MS);
      items.push({
        productId,
        productName: r.name || '',
        productSku: r.sku || '',
        supplierId: r.supplier_id != null ? Number(r.supplier_id) : null,
        supplierName: r.supplier_name || '',
        ordersQty: Math.round(ordersQty),
        fboQty: Math.round(fboQty),
        dailyRate: Math.round(dailyRate * 100) / 100,
        onHand,
        reserved: Math.min(rsv, onHand),
        inKits: kits,
        available,
        incoming: inc,
        daysLeft: round1(daysLeft),
        daysLeftWithIncoming: round1(daysLeftWithIncoming),
        runOutDate: available > 0 ? mskYmd(runOut) : null,
        coveredByIncoming: daysLeftWithIncoming > alert,
        toOrder,
        orderMultiple,
        urgency,
      });
    }

    const rank = Object.fromEntries(RUNWAY_URGENCY.map((u, i) => [u, i]));
    items.sort(
      (a, b) =>
        rank[a.urgency] - rank[b.urgency] ||
        Number(a.coveredByIncoming) - Number(b.coveredByIncoming) ||
        a.daysLeft - b.daysLeft ||
        b.dailyRate - a.dailyRate
    );

    const summary = { out: 0, critical: 0, soon: 0, coveredByIncoming: 0, toOrderUnits: 0 };
    for (const it of items) {
      summary[it.urgency] += 1;
      if (it.coveredByIncoming) summary.coveredByIncoming += 1;
      else summary.toOrderUnits += it.toOrder;
    }

    return {
      params: { periodDays: days, alertDays: alert, coverDays: cover, criticalDays: criticalDays, warehouseId: wantWh },
      warehouses: allWarehouses,
      sources: { orders: countOrders, fboSupplies: countSupplies },
      summary,
      totalItems: items.length,
      items: items.slice(0, lim),
    };
  }
}

export default new StockRunwayService();
