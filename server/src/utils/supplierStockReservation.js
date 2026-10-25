/**
 * Резерв остатка поставщика = непринятое количество открытых закупок.
 * Между синхронизациями два заказа не видят один и тот же свободный остаток.
 */

import { sumOrderableSupplierWarehouseStock } from './supplierProcurementArrival.js';

export function freeSupplierUnits(orderable, reserved) {
  const stock = Math.max(0, Math.floor(Number(orderable) || 0));
  const hold = Math.max(0, Math.floor(Number(reserved) || 0));
  return Math.max(0, stock - hold);
}

/** Подзапрос: сколько уже держит открытая закупка у этого поставщика. */
export function sqlOpenSupplierReserved(supplierExpr, productExpr) {
  return `COALESCE((
    SELECT SUM(GREATEST(0, COALESCE(pi.expected_quantity, 0) - COALESCE(pi.received_quantity, 0)))::int
      FROM purchase_items pi
      INNER JOIN purchases pu ON pu.id = pi.purchase_id
     WHERE pu.supplier_id = ${supplierExpr}
       AND pi.product_id = ${productExpr}
       AND LOWER(TRIM(COALESCE(pu.status, ''))) = 'open'
  ), 0)`;
}

/**
 * В строку закупки попадают только целые заказы, которые помещаются в свободный остаток.
 * Частично привязанный заказ больше не докупается (ever_linked), поэтому режем по заказам, не по штукам.
 */
export function sourceOrdersFittingFreeStock(sources, free, lineQty = 0) {
  const list = Array.isArray(sources) ? sources : [];
  const freeN = Math.max(0, Math.floor(Number(free) || 0));
  if (!list.length) {
    return { quantity: Math.max(0, Math.floor(Number(lineQty) || 0)), sourceOrders: [] };
  }

  const specified = list.reduce((sum, order) => {
    const q = Math.floor(Number(order?.quantity) || 0);
    return sum + (q > 0 ? q : 0);
  }, 0);

  if (specified <= 0) {
    const need = Math.max(1, Math.floor(Number(lineQty) || 1));
    if (need <= freeN) return { quantity: need, sourceOrders: list };
    return { quantity: 0, sourceOrders: [] };
  }

  const accepted = [];
  let left = freeN;
  for (const order of list) {
    const q = Math.max(1, Math.floor(Number(order?.quantity) || 1));
    if (q > left) continue;
    accepted.push(order);
    left -= q;
  }
  const quantity = accepted.reduce(
    (sum, order) => sum + Math.max(1, Math.floor(Number(order?.quantity) || 1)),
    0
  );
  return { quantity, sourceOrders: accepted };
}

export async function capDemandLineToSupplierFreeStock(
  client,
  { supplierId, productId, quantity, sourceOrders, now = new Date() } = {}
) {
  const sid = Number(supplierId);
  const pid = Number(productId);
  const sources = Array.isArray(sourceOrders) ? sourceOrders : [];
  if (!sources.length || !Number.isFinite(sid) || sid < 1 || !Number.isFinite(pid) || pid < 1) {
    return {
      quantity: Math.max(0, Math.floor(Number(quantity) || 0)),
      sourceOrders: sources,
      capped: false,
    };
  }

  const locked = await client.query(
    `SELECT ss.stock, ss.warehouses, s.api_config
       FROM supplier_stocks ss
       INNER JOIN suppliers s ON s.id = ss.supplier_id
      WHERE ss.supplier_id = $1 AND ss.product_id = $2
      FOR UPDATE OF ss`,
    [sid, pid]
  );
  const row = locked.rows?.[0];
  if (!row) return { quantity: 0, sourceOrders: [], capped: true };

  const reservedRes = await client.query(
    `SELECT ${sqlOpenSupplierReserved('$1', '$2')}::int AS reserved`,
    [sid, pid]
  );
  const orderable = sumOrderableSupplierWarehouseStock({
    apiConfig: row.api_config,
    stockWarehouses: row.warehouses,
    aggregatedStock: row.stock,
    now,
  });
  const free = freeSupplierUnits(orderable, reservedRes.rows?.[0]?.reserved);
  const fitted = sourceOrdersFittingFreeStock(sources, free, quantity);
  return {
    ...fitted,
    capped: fitted.quantity < Math.max(0, Math.floor(Number(quantity) || 0)),
  };
}
