/**
 * Прогноз закупки по продажам FBS: продажи за период → потребность на период закупки.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { batchWarehouseScopedIncomingMap } from './kitStock.service.js';

const FBS_MARKETPLACES = ['ozon', 'wb', 'wildberries', 'ym', 'yandex', 'yandexmarket'];

function parseDateYmd(raw) {
  const s = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function defaultSalesRange(days = 7) {
  const n = Math.max(1, Math.floor(Number(days) || 7));
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (n - 1));
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { salesDateFrom: fmt(from), salesDateTo: fmt(to) };
}

function toExclusiveEnd(dateToYmd) {
  const [y, mo, d] = dateToYmd.split('-').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, mo - 1, d + 1, 0, 0, 0)).toISOString();
}

function toInclusiveStart(dateFromYmd) {
  const [y, mo, d] = dateFromYmd.split('-').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0)).toISOString();
}

function daysInclusive(fromYmd, toYmd) {
  const [y1, m1, d1] = fromYmd.split('-').map((x) => parseInt(x, 10));
  const [y2, m2, d2] = toYmd.split('-').map((x) => parseInt(x, 10));
  const start = Date.UTC(y1, m1 - 1, d1);
  const end = Date.UTC(y2, m2 - 1, d2);
  return Math.max(1, Math.floor((end - start) / 86400000) + 1);
}

/**
 * Сколько штук комплектующей уже лежит на складе внутри собранных комплектов.
 * Пример: 3 комплекта по 2 наконечника → 6 шт. «в комплектах».
 * @returns {Promise<Map<number, number>>} componentId → qty
 */
async function batchComponentQtyInKitsOnWarehouse(componentIds, warehouseId) {
  const ids = [...new Set((componentIds || []).filter((n) => Number.isFinite(n) && n > 0))];
  const map = new Map();
  if (!ids.length || !Number.isFinite(warehouseId) || warehouseId < 1) return map;

  const r = await query(
    `
    SELECT
      kc.component_product_id AS component_id,
      COALESCE(
        SUM(
          GREATEST(COALESCE(pws.quantity, 0), 0)::bigint
          * GREATEST(COALESCE(kc.quantity, 1), 1)::bigint
        ),
        0
      )::int AS qty_in_kits
    FROM kit_components kc
    INNER JOIN product_warehouse_stock pws
      ON pws.product_id = kc.kit_product_id
     AND pws.warehouse_id = $2
    WHERE kc.component_product_id = ANY($1::bigint[])
      AND COALESCE(pws.quantity, 0) > 0
    GROUP BY kc.component_product_id
    `,
    [ids, warehouseId]
  );

  for (const row of r.rows || []) {
    const cid = Number(row.component_id);
    const qty = Math.max(0, Number(row.qty_in_kits) || 0);
    if (Number.isFinite(cid) && cid > 0) map.set(cid, qty);
  }
  return map;
}

class ProcurementForecastService {
  async getFbsForecast({
    profileId,
    organizationId,
    warehouseId,
    salesDateFrom = null,
    salesDateTo = null,
    procurementDays = 7,
    bufferPercent = 0,
  } = {}) {
    const pid = Number(profileId);
    const orgId = Number(organizationId);
    const whId = Number(warehouseId);
    if (!Number.isFinite(pid) || pid < 1) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    if (!Number.isFinite(orgId) || orgId < 1) {
      const err = new Error('Выберите организацию');
      err.statusCode = 400;
      throw err;
    }
    if (!Number.isFinite(whId) || whId < 1) {
      const err = new Error('Выберите склад');
      err.statusCode = 400;
      throw err;
    }
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Доступно только с PostgreSQL');
      err.statusCode = 501;
      throw err;
    }

    const defaults = defaultSalesRange(7);
    const fromYmd = parseDateYmd(salesDateFrom) || defaults.salesDateFrom;
    const toYmd = parseDateYmd(salesDateTo) || defaults.salesDateTo;
    const salesStart = toInclusiveStart(fromYmd);
    const salesEnd = toExclusiveEnd(toYmd);
    const salesPeriodDays = daysInclusive(fromYmd, toYmd);
    const procDays = Math.max(1, Math.floor(Number(procurementDays) || 7));
    const bufferPctRaw = Number(bufferPercent);
    const bufferPct = Number.isFinite(bufferPctRaw)
      ? Math.max(0, Math.min(500, bufferPctRaw))
      : 0;
    const bufferFactor = 1 + bufferPct / 100;

    const sql = `
      WITH raw_sales AS (
        SELECT
          o.product_id,
          SUM(GREATEST(COALESCE(o.quantity, 1), 1))::int AS sold_qty
        FROM orders o
        WHERE o.profile_id = $1
          AND o.product_id IS NOT NULL
          AND LOWER(TRIM(o.status)) = 'delivered'
          AND LOWER(TRIM(COALESCE(o.marketplace, ''))) = ANY($5::text[])
          AND COALESCE(o.terminal_status_at, o.created_at) >= $3::timestamptz
          AND COALESCE(o.terminal_status_at, o.created_at) < $4::timestamptz
        GROUP BY o.product_id
      ),
      exploded_sales AS (
        SELECT kc.component_product_id AS product_id, SUM(rs.sold_qty * kc.quantity)::int AS sold_qty
        FROM raw_sales rs
        INNER JOIN kit_components kc ON kc.kit_product_id = rs.product_id
        GROUP BY kc.component_product_id
        UNION ALL
        SELECT rs.product_id, SUM(rs.sold_qty)::int AS sold_qty
        FROM raw_sales rs
        INNER JOIN products pk ON pk.id = rs.product_id AND pk.profile_id = $1
        WHERE NOT EXISTS (
          SELECT 1 FROM kit_components kc2 WHERE kc2.kit_product_id = rs.product_id
        )
        GROUP BY rs.product_id
      ),
      sales_by_product AS (
        SELECT product_id, SUM(sold_qty)::int AS sold_qty
        FROM exploded_sales
        GROUP BY product_id
      ),
      eligible AS (
        SELECT p.id AS product_id
        FROM products p
        WHERE p.profile_id = $1
          AND NOT EXISTS (SELECT 1 FROM kit_components kc WHERE kc.kit_product_id = p.id)
      )
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.sku AS product_sku,
        p.supplier_id,
        s.name AS supplier_name,
        COALESCE(sb.sold_qty, 0)::int AS sold_qty,
        COALESCE(pws.quantity, 0)::int AS on_hand,
        CASE
          WHEN EXISTS (SELECT 1 FROM kit_components kc WHERE kc.component_product_id = p.id)
          THEN true ELSE false
        END AS is_component
      FROM eligible e
      INNER JOIN products p ON p.id = e.product_id
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN sales_by_product sb ON sb.product_id = p.id
      LEFT JOIN product_warehouse_stock pws ON pws.product_id = p.id AND pws.warehouse_id = $2
      WHERE COALESCE(sb.sold_qty, 0) > 0
      ORDER BY COALESCE(sb.sold_qty, 0) DESC, p.name ASC
      LIMIT 2000
    `;

    const r = await query(sql, [
      pid,
      whId,
      salesStart,
      salesEnd,
      FBS_MARKETPLACES,
    ]);

    const rows = r.rows || [];
    const productIds = rows
      .map((row) => Number(row.product_id))
      .filter((n) => Number.isFinite(n) && n > 0);
    // «В пути» — как на странице остатков: журнал incoming + закупки по выбранному складу
    // (не глобальный products.incoming_quantity, иначе чужие склады занижают «Закупить»).
    const incomingByProduct = await batchWarehouseScopedIncomingMap(productIds, {
      warehouseId: whId,
      profileId: pid,
    });
    // Наличие внутри собранных комплектов на этом складе (не только свободные комплектующие).
    const inKitsByProduct = await batchComponentQtyInKitsOnWarehouse(productIds, whId);

    const items = rows.map((row) => {
      const productId = Number(row.product_id);
      const soldQty = Number(row.sold_qty) || 0;
      const onHand = Number(row.on_hand) || 0;
      const incoming = Math.max(0, Number(incomingByProduct.get(productId)) || 0);
      const onHandInKits = Math.max(0, Number(inKitsByProduct.get(productId)) || 0);
      const dailyRate = soldQty / salesPeriodDays;
      // Запас % увеличивает потребность относительно темпа продаж (не обязательно).
      const projectedNeed = Math.ceil(dailyRate * procDays * bufferFactor);
      const toPurchase = Math.max(0, projectedNeed - onHand - incoming - onHandInKits);
      return {
        productId,
        productName: row.product_name || '',
        productSku: row.product_sku || '',
        supplierId: row.supplier_id != null ? Number(row.supplier_id) : null,
        supplierName: row.supplier_name || '',
        isComponent: Boolean(row.is_component),
        soldQty,
        salesPeriodDays,
        procurementDays: procDays,
        bufferPercent: bufferPct,
        projectedNeed,
        onHand,
        incoming,
        onHandInKits,
        toPurchase,
      };
    });

    const summary = items.reduce(
      (acc, row) => {
        acc.soldQty += row.soldQty;
        acc.projectedNeed += row.projectedNeed;
        acc.onHand += row.onHand;
        acc.incoming += row.incoming;
        acc.onHandInKits += row.onHandInKits;
        acc.toPurchase += row.toPurchase;
        if (row.toPurchase > 0) acc.linesToPurchase += 1;
        return acc;
      },
      {
        soldQty: 0,
        projectedNeed: 0,
        onHand: 0,
        incoming: 0,
        onHandInKits: 0,
        toPurchase: 0,
        linesToPurchase: 0,
      }
    );

    return {
      organizationId: orgId,
      warehouseId: whId,
      salesPeriod: { dateFrom: fromYmd, dateTo: toYmd, days: salesPeriodDays },
      procurementDays: procDays,
      bufferPercent: bufferPct,
      summary,
      items,
    };
  }
}

export default new ProcurementForecastService();
