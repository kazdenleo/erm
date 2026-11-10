/**
 * Почему заказы в «Новый» не ушли поставщику.
 * node scripts/admin/_tmp_probe_why_new_orders.mjs [orderId ...]
 */
import { query, closePool } from '../../src/config/database.js';
import {
  sumPurchasableSupplierWarehouseStock,
  freePurchasableSupplierStock,
  resolveProcurementArrivalBucketFromApiConfig,
} from '../../src/utils/supplierProcurementArrival.js';
import { resolveSupplierWarehouseNameForMainWarehouse } from '../../src/utils/citySupplierWarehouse.js';
import { autoOrderSettingsFromApiConfig } from '../../src/utils/supplierAutoOrderSettings.js';

const ORDER_IDS = process.argv.slice(2).filter(Boolean);
const DEFAULT_IDS = ['6153069924', '6153017447'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const want = (ORDER_IDS.length ? ORDER_IDS : DEFAULT_IDS).map(String);

  const orders = await query(
    `SELECT o.id, o.order_id, o.marketplace, o.status, o.product_id, o.offer_id,
            o.marketplace_sku, o.product_name, o.quantity, o.profile_id,
            o.warehouse_id, o.shipment_date, o.created_at, o.updated_at,
            w.name AS warehouse_name, w.address AS warehouse_address,
            p.sku AS product_sku, p.name AS pname, p.quantity AS stock_qty,
            p.reserved_quantity, p.incoming_quantity
     FROM orders o
     LEFT JOIN warehouses w ON w.id = o.warehouse_id
     LEFT JOIN products p ON p.id = o.product_id
     WHERE o.order_id = ANY($1::text[])
        OR o.order_id = ANY($2::text[])
     ORDER BY o.id DESC`,
    [want, want.map((x) => x.replace(/^0+/, ''))]
  );

  // WB sometimes stores with prefixes — broaden
  if (!orders.rows?.length) {
    const fuzzy = await query(
      `SELECT o.id, o.order_id, o.marketplace, o.status, o.product_id, o.offer_id,
              o.marketplace_sku, o.product_name, o.quantity, o.profile_id,
              o.warehouse_id, o.shipment_date, o.created_at,
              w.name AS warehouse_name,
              p.sku AS product_sku, p.quantity AS stock_qty,
              p.reserved_quantity, p.incoming_quantity
       FROM orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
       LEFT JOIN products p ON p.id = o.product_id
       WHERE o.order_id LIKE ANY($1::text[])
       ORDER BY o.created_at DESC
       LIMIT 20`,
      [want.map((x) => `%${x}%`)]
    );
    console.log('fuzzy', JSON.stringify(fuzzy.rows, null, 2));
  }

  console.log('=== orders ===');
  for (const o of orders.rows || []) {
    console.log(
      JSON.stringify({
        dbId: o.id,
        orderId: o.order_id,
        mp: o.marketplace,
        status: o.status,
        productId: o.product_id,
        sku: o.product_sku || o.offer_id || o.marketplace_sku,
        qty: o.quantity,
        profileId: o.profile_id,
        warehouseId: o.warehouse_id,
        warehouse: o.warehouse_name,
        shipment: o.shipment_date,
        stock: o.stock_qty,
        reserved: o.reserved_quantity,
        incoming: o.incoming_quantity,
        created: o.created_at,
      })
    );
  }

  for (const o of orders.rows || []) {
    console.log(`\n======== order ${o.order_id} ========`);
    const reasons = [];
    const pid = num(o.profile_id);
    const productId = num(o.product_id);
    const qty = Math.max(1, parseInt(o.quantity, 10) || 1);

    if (!productId) {
      reasons.push('нет product_id — автозакупка не знает товар');
      console.log('REASONS', reasons);
      continue;
    }

    const sync = await query(
      `SELECT id, name, settings FROM profiles WHERE id = $1`,
      [pid]
    ).catch(() => ({ rows: [] }));
    const profile = sync.rows?.[0];
    console.log('profile', {
      id: profile?.id,
      name: profile?.name,
      settingsKeys: profile?.settings ? Object.keys(profile.settings) : null,
    });

    // suppliers with auto orders
    const sup = await query(
      `SELECT s.id, s.name, s.code, s.api_config, s.is_active,
              COALESCE((s.api_config->>'autoOrdersEnabled')::boolean,
                       (s.api_config->>'auto_orders_enabled')::boolean, false) AS auto_on
       FROM suppliers s
       WHERE s.profile_id = $1 OR s.profile_id IS NULL
       ORDER BY s.id`,
      [pid]
    );
    const autoSuppliers = (sup.rows || []).filter((s) => {
      const cfg = autoOrderSettingsFromApiConfig(s.api_config || {});
      return s.is_active !== false && (cfg.autoOrdersEnabled || s.auto_on);
    });
    console.log(
      'auto suppliers',
      autoSuppliers.map((s) => ({ id: s.id, name: s.name, code: s.code }))
    );
    if (!autoSuppliers.length) reasons.push('нет поставщиков с autoOrdersEnabled');

    const stocks = await query(
      `SELECT ss.supplier_id, ss.stock, ss.price, ss.delivery_days, ss.warehouses,
              s.name, s.code, s.api_config
       FROM supplier_stocks ss
       JOIN suppliers s ON s.id = ss.supplier_id
       WHERE ss.product_id = $1
       ORDER BY ss.price ASC NULLS LAST`,
      [productId]
    );
    console.log('supplier_stocks rows', stocks.rows?.length || 0);

    const wid = num(o.warehouse_id);
    for (const row of stocks.rows || []) {
      const sid = num(row.supplier_id);
      const hint = wid
        ? await resolveSupplierWarehouseNameForMainWarehouse(wid, sid, { profileId: pid })
        : null;
      const purchasable = sumPurchasableSupplierWarehouseStock({
        apiConfig: row.api_config,
        stockWarehouses: row.warehouses,
        aggregatedStock: row.stock,
        warehouseNameHint: hint,
      });
      const reservedR = await query(
        `SELECT COALESCE(SUM(GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity,0))),0)::int AS r
         FROM purchase_items pi
         JOIN purchases pu ON pu.id = pi.purchase_id
         WHERE pu.supplier_id = $1 AND pi.product_id = $2
           AND pu.status IN ('open','partial')
           AND COALESCE(pu.archived, false) = false`,
        [sid, productId]
      ).catch(() => ({ rows: [{ r: 0 }] }));
      const reserved = Number(reservedR.rows?.[0]?.r) || 0;
      const free = freePurchasableSupplierStock({
        apiConfig: row.api_config,
        stockWarehouses: row.warehouses,
        aggregatedStock: row.stock,
        reservedQty: reserved,
        warehouseNameHint: hint,
      });
      const cfg = autoOrderSettingsFromApiConfig(row.api_config);
      const bucket = resolveProcurementArrivalBucketFromApiConfig(
        row.api_config,
        new Date(),
        null,
        row.code,
        hint
      );
      console.log(
        JSON.stringify({
          supplierId: sid,
          name: row.name,
          code: row.code,
          autoOn: cfg.autoOrdersEnabled,
          minOrder: cfg.minOrderAmount,
          price: row.price,
          aggStock: row.stock,
          hint,
          purchasable,
          reserved,
          free,
          need: qty,
          enough: free >= qty,
          bucket,
        })
      );
    }

    const onHand =
      Math.max(0, Number(o.stock_qty) || 0) - Math.max(0, Number(o.reserved_quantity) || 0);
    if (onHand >= qty) {
      reasons.push(
        `на складе хватает свободного остатка (~${onHand}) — автозакупка может не покупать, а резервировать`
      );
    }

    const enoughAuto = (stocks.rows || []).some((row) => {
      /* filled in loop logs */
      return false;
    });
    void enoughAuto;

    const anyAutoStock = [];
    for (const row of stocks.rows || []) {
      const sid = num(row.supplier_id);
      const cfg = autoOrderSettingsFromApiConfig(row.api_config);
      if (!cfg.autoOrdersEnabled) continue;
      const hint = wid
        ? await resolveSupplierWarehouseNameForMainWarehouse(wid, sid, { profileId: pid })
        : null;
      const reservedR = await query(
        `SELECT COALESCE(SUM(GREATEST(0, pi.expected_quantity - COALESCE(pi.received_quantity,0))),0)::int AS r
         FROM purchase_items pi
         JOIN purchases pu ON pu.id = pi.purchase_id
         WHERE pu.supplier_id = $1 AND pi.product_id = $2
           AND pu.status IN ('open','partial')`,
        [sid, productId]
      ).catch(() => ({ rows: [{ r: 0 }] }));
      const free = freePurchasableSupplierStock({
        apiConfig: row.api_config,
        stockWarehouses: row.warehouses,
        aggregatedStock: row.stock,
        reservedQty: Number(reservedR.rows?.[0]?.r) || 0,
        warehouseNameHint: hint,
      });
      anyAutoStock.push({ sid, name: row.name, free, hint, min: cfg.minOrderAmount });
    }
    const covering = anyAutoStock.filter((x) => x.free >= qty);
    if (!covering.length) {
      reasons.push(
        anyAutoStock.length
          ? `у auto-поставщиков нет свободного остатка в городе (need=${qty}): ${JSON.stringify(anyAutoStock)}`
          : 'нет auto-поставщиков с остатком по этому SKU'
      );
    } else {
      console.log('covering auto suppliers', covering);
      for (const c of covering) {
        if (c.min != null && Number(c.min) > 0) {
          const priceR = await query(
            `SELECT price FROM supplier_stocks WHERE supplier_id=$1 AND product_id=$2`,
            [c.sid, productId]
          );
          const price = Number(priceR.rows?.[0]?.price) || 0;
          const line = price * qty;
          if (line < Number(c.min)) {
            reasons.push(
              `поставщик ${c.name}: сумма линии ${line} < мин. заказа ${c.min} — может копить (если срок не горит)`
            );
          }
        }
      }
    }

    // already in open purchase?
    const inPur = await query(
      `SELECT pu.id, pu.status, pu.supplier_id, s.name AS supplier_name, pu.note
       FROM purchases pu
       JOIN purchase_items pi ON pi.purchase_id = pu.id
       LEFT JOIN suppliers s ON s.id = pu.supplier_id
       WHERE pi.product_id = $1
         AND pu.status IN ('open','partial')
         AND pi.source_orders::text ILIKE $2
       LIMIT 10`,
      [productId, `%${o.order_id}%`]
    );
    if (inPur.rows?.length) {
      reasons.push(`уже в открытой закупке: ${JSON.stringify(inPur.rows)}`);
    }

    if (!reasons.length) {
      reasons.push(
        'по данным БД блокировки не видно — смотреть лог AutoProcurement / ещё не дошёл cron */2 / shipment_date пустой'
      );
    }
    console.log('REASONS:', reasons);
  }

  // recent auto procurement log hints from pm2? skip
  const recentNew = await query(
    `SELECT COUNT(*)::int AS n FROM orders
     WHERE status IN ('new','Новый') OR lower(status) = 'new'`
  );
  console.log('\nnew orders count rough', recentNew.rows?.[0]);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
