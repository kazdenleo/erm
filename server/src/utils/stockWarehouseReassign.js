/**
 * Перенос складских количеств между складами в журнале (incoming / наличие).
 */

import stockMovementsRepositoryPG from '../repositories/stock_movements.repository.pg.js';

function normalizeWarehouseId(warehouseId) {
  if (warehouseId == null || warehouseId === '') return null;
  const n = Number(warehouseId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Нетто incoming по товару на складе (все документы). */
export async function readProductIncomingNetOnWarehouse(client, productId, warehouseId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  const wh = normalizeWarehouseId(warehouseId);
  const whSql = wh != null ? 'AND warehouse_id = $2' : 'AND warehouse_id IS NULL';
  const params = wh != null ? [pid, wh] : [pid];
  const run = client && typeof client.query === 'function' ? client.query.bind(client) : null;
  if (!run) return 0;
  const r = await run(
    `SELECT COALESCE(SUM(quantity_change), 0)::int AS net
     FROM stock_movements
     WHERE product_id = $1
       AND LOWER(TRIM(type::text)) = 'incoming'
       ${whSql}`,
    params
  );
  return Math.max(0, Number(r.rows?.[0]?.net) || 0);
}

/** Нетто incoming по товару на складе в рамках документа (meta.document_id / purchase_id / …). */
export async function readDocumentIncomingNetOnWarehouse(
  client,
  productId,
  warehouseId,
  { metaKey, documentId }
) {
  const pid = Number(productId);
  const docId = parseInt(documentId, 10);
  const key = metaKey != null ? String(metaKey).trim() : '';
  if (!Number.isFinite(pid) || pid < 1 || !key || !Number.isFinite(docId) || docId < 1) return 0;

  const wh = normalizeWarehouseId(warehouseId);

  const run = client && typeof client.query === 'function' ? client.query.bind(client) : null;
  if (!run) return 0;

  const r =
    wh != null
      ? await run(
          `SELECT COALESCE(SUM(quantity_change), 0)::int AS net
           FROM stock_movements
           WHERE product_id = $1
             AND LOWER(TRIM(type::text)) = 'incoming'
             AND warehouse_id = $2
             AND (meta->>$4) IS NOT NULL
             AND (meta->>$4)::bigint = $3`,
          [pid, wh, docId, key]
        )
      : await run(
          `SELECT COALESCE(SUM(quantity_change), 0)::int AS net
           FROM stock_movements
           WHERE product_id = $1
             AND LOWER(TRIM(type::text)) = 'incoming'
             AND warehouse_id IS NULL
             AND (meta->>$3) IS NOT NULL
             AND (meta->>$3)::bigint = $2`,
          [pid, docId, key]
        );
  return Math.max(0, Number(r.rows?.[0]?.net) || 0);
}

async function insertIncomingLeg(
  client,
  { productId, quantityChange, reason, meta, warehouseId, profileId, documentMetaKey = null, documentId = null }
) {
  const wh = normalizeWarehouseId(warehouseId);
  const docKey = documentMetaKey != null ? String(documentMetaKey).trim() : '';
  const docId = documentId != null ? parseInt(documentId, 10) : null;
  const before =
    docKey && Number.isFinite(docId) && docId > 0
      ? await readDocumentIncomingNetOnWarehouse(client, productId, wh, {
          metaKey: docKey,
          documentId: docId,
        })
      : await readProductIncomingNetOnWarehouse(client, productId, wh);
  const after = Math.max(0, before + Number(quantityChange || 0));
  const metaOut = {
    ...(meta && typeof meta === 'object' ? meta : {}),
    warehouse_incoming_before: before,
    warehouse_incoming_after: after,
    warehouse_id: wh,
  };
  await stockMovementsRepositoryPG.insertSnapshotAfterProduct(client, {
    productId,
    type: 'incoming',
    quantityChange,
    reason,
    meta: metaOut,
    warehouseId: wh,
    profileId,
  });
}

/**
 * Расчёт ног переноса incoming между складами.
 * pendingQty: на новом складе начисляем полное непринятое ожидание;
 * со старого списываем min(pending, documentNet, warehouseNet).
 */
export function computeIncomingWarehouseTransferLegs({
  pendingQty = null,
  transferQty = null,
  documentNetOnSource = null,
  warehouseIncomingNet = null,
} = {}) {
  if (pendingQty != null && Number(pendingQty) > 0) {
    const pending = Math.max(0, Math.floor(Number(pendingQty)));
    const docNet =
      documentNetOnSource != null
        ? Math.max(0, Math.floor(Number(documentNetOnSource)))
        : pending;
    let subtractQty = Math.min(pending, docNet);
    if (warehouseIncomingNet != null) {
      subtractQty = Math.min(
        subtractQty,
        Math.max(0, Math.floor(Number(warehouseIncomingNet)))
      );
    }
    return { subtractQty, addQty: pending };
  }

  let qty = Math.max(0, Math.floor(Number(transferQty) || 0));
  if (warehouseIncomingNet != null) {
    qty = Math.min(qty, Math.max(0, Math.floor(Number(warehouseIncomingNet))));
  }
  return { subtractQty: qty, addQty: qty };
}

/** Глобальное «в пути» по товару (сумма incoming по всем складам). */
export async function readProductGlobalIncomingNet(client, productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  const run = client && typeof client.query === 'function' ? client.query.bind(client) : null;
  if (!run) return 0;
  const r = await run(
    `SELECT COALESCE(SUM(quantity_change), 0)::int AS net
     FROM stock_movements
     WHERE product_id = $1
       AND LOWER(TRIM(type::text)) = 'incoming'`,
    [pid]
  );
  return Math.max(0, Number(r.rows?.[0]?.net) || 0);
}

/**
 * Перенос «в пути» (incoming) со склада на склад: две проводки в журнале.
 * @returns {number} перенесённое количество (0 — нечего переносить)
 */
export async function transferIncomingBetweenWarehouses(
  client,
  {
    productId,
    fromWarehouseId,
    toWarehouseId,
    quantity,
    reason,
    meta = {},
    profileId = null,
    documentNetOnSource = null,
  }
) {
  const toWh = normalizeWarehouseId(toWarehouseId);
  if (toWh == null) return 0;

  const fromWh = normalizeWarehouseId(fromWarehouseId);
  const docMetaKey =
    meta?.purchase_id != null
      ? 'purchase_id'
      : meta?.warehouse_receipt_id != null
        ? 'warehouse_receipt_id'
        : null;
  const docId =
    docMetaKey === 'purchase_id'
      ? meta.purchase_id
      : docMetaKey === 'warehouse_receipt_id'
        ? meta.warehouse_receipt_id
        : null;

  const pendingQty = Math.max(0, Math.floor(Number(quantity) || 0));
  let transferQty = pendingQty;
  if (transferQty <= 0) {
    transferQty =
      documentNetOnSource != null && Number.isFinite(Number(documentNetOnSource))
        ? Math.max(0, Math.floor(Number(documentNetOnSource)))
        : 0;
  }
  if (transferQty <= 0 && docMetaKey && docId != null) {
    transferQty = await readDocumentIncomingNetOnWarehouse(client, productId, fromWh, {
      metaKey: docMetaKey,
      documentId: docId,
    });
  }
  if (transferQty <= 0) {
    transferQty = await readProductIncomingNetOnWarehouse(client, productId, fromWh);
  }

  const netOnFrom =
    fromWh != null
      ? await readProductIncomingNetOnWarehouse(client, productId, fromWh)
      : await readProductIncomingNetOnWarehouse(client, productId, null);

  let docNetOnSource = documentNetOnSource;
  if (pendingQty > 0 && docNetOnSource == null && docMetaKey && docId != null) {
    docNetOnSource = await readDocumentIncomingNetOnWarehouse(client, productId, fromWh, {
      metaKey: docMetaKey,
      documentId: docId,
    });
  }

  const { subtractQty, addQty } =
    pendingQty > 0
      ? computeIncomingWarehouseTransferLegs({
          pendingQty,
          documentNetOnSource: docNetOnSource ?? 0,
          warehouseIncomingNet: netOnFrom,
        })
      : computeIncomingWarehouseTransferLegs({
          transferQty,
          warehouseIncomingNet: netOnFrom,
        });

  if (addQty <= 0) return 0;

  const metaBase = { ...(meta && typeof meta === 'object' ? meta : {}), warehouse_reassign: true };
  const legDoc = { documentMetaKey: docMetaKey, documentId: docId };

  if (subtractQty > 0) {
    await insertIncomingLeg(client, {
      productId,
      quantityChange: -subtractQty,
      reason,
      meta: { ...metaBase, from_warehouse_id: fromWh, to_warehouse_id: toWh },
      warehouseId: fromWh,
      profileId,
      ...legDoc,
    });
  }

  await insertIncomingLeg(client, {
    productId,
    quantityChange: addQty,
    reason,
    meta: { ...metaBase, from_warehouse_id: fromWh, to_warehouse_id: toWh },
    warehouseId: toWh,
    profileId,
    ...legDoc,
  });

  return addQty;
}
