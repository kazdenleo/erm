/**
 * Purchases Service
 * Закупки (ожидание) и приёмки по закупке со сканированием.
 *
 * Важное правило: stock_actual = products.quantity (как сейчас),
 * stock_reserved = products.reserved_quantity (как сейчас),
 * stock_incoming = products.incoming_quantity (новое).
 *
 * Изменения actual/incoming выполняются только транзакционно и всегда пишутся в stock_movements.
 */

import { query, transaction } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import ordersService from './orders.service.js';

// Anti-duplicate scans (in-memory): receiptId|barcode -> ts.
// Один физический скан иногда даёт 2-3 HTTP запроса (\\n + Enter, или повтор в драйвере).
const _scanRecent = new Map();
function scanKey(receiptId, barcode, sku) {
  const rid = Number(receiptId);
  const b = barcode != null ? String(barcode).trim() : '';
  const s = sku != null ? String(sku).trim() : '';
  const digits = b ? b.replace(/\\D+/g, '') : '';
  return `${rid}|${digits || b || s}`;
}
function shouldIgnoreDuplicateScan(key, windowMs = 800) {
  const now = Date.now();
  const prev = _scanRecent.get(key) || 0;
  if (prev && now - prev < windowMs) return true;
  _scanRecent.set(key, now);
  if (_scanRecent.size > 5000) {
    for (const [k, t] of _scanRecent.entries()) {
      if (now - t > 5 * 60 * 1000) _scanRecent.delete(k);
    }
  }
  return false;
}

let _hasPurchasePriceCol = null;
async function hasPurchasePriceColumn(executor = query) {
  if (_hasPurchasePriceCol != null) return _hasPurchasePriceCol;
  const r = await executor(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = 'purchase_items' AND column_name = 'purchase_price'
     LIMIT 1`
  );
  _hasPurchasePriceCol = (r.rows?.length ?? 0) > 0;
  return _hasPurchasePriceCol;
}

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

async function getDefaultWarehouseIdForTx(client) {
  const r = await client.query(
    `SELECT id FROM warehouses WHERE type = 'warehouse' AND supplier_id IS NULL ORDER BY id ASC LIMIT 1`
  );
  return r.rows?.[0]?.id ?? null;
}

async function resolveReceiptWarehouseIdForTx(client, warehouseId) {
  if (warehouseId == null || warehouseId === '') return await getDefaultWarehouseIdForTx(client);
  const wid = typeof warehouseId === 'string' ? parseInt(warehouseId, 10) : Number(warehouseId);
  if (!wid || Number.isNaN(wid)) {
    const err = new Error('Некорректный склад приёмки');
    err.statusCode = 400;
    throw err;
  }
  const r = await client.query(
    `SELECT id FROM warehouses WHERE id = $1 AND type = 'warehouse' AND supplier_id IS NULL LIMIT 1`,
    [wid]
  );
  if (!r.rows?.length) {
    const err = new Error('Склад приёмки не найден');
    err.statusCode = 404;
    throw err;
  }
  return r.rows[0].id;
}

/** Увеличить свободный остаток на складе по умолчанию (дельта); products.quantity синхронизируется триггером. */
async function addToDefaultWarehouseStock(client, productId, delta) {
  const d = Math.max(0, parseInt(delta, 10) || 0);
  if (d <= 0) return;
  const dwId = await getDefaultWarehouseIdForTx(client);
  if (!dwId) return;
  await client.query(
    `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
     VALUES ($1, $2, GREATEST(0, COALESCE((SELECT quantity FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE), 0) + $3::int))
     ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = GREATEST(0, product_warehouse_stock.quantity + $3::int)`,
    [productId, dwId, d]
  );
}

async function assertPurchaseInProfile(client, purchaseId, profileId) {
  const pid = normalizeProfileId(profileId);
  if (pid == null) return;
  const r = await client.query(
    `SELECT 1 FROM purchases WHERE id = $1 AND profile_id = $2 LIMIT 1`,
    [purchaseId, pid]
  );
  if (!r.rows?.length) {
    const err = new Error('Закупка не найдена');
    err.statusCode = 404;
    throw err;
  }
}

/** marketplace как в API заказов → значение в колонке orders.marketplace */
function orderMarketplaceToDb(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'ym' || m === 'yandexmarket') return 'ym';
  if (m === 'manual') return 'manual';
  return m === 'ozon' ? 'ozon' : 'ozon';
}

function normalizeSourceOrderList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (!x || x.marketplace == null || x.orderId == null) continue;
    const marketplace = String(x.marketplace).trim();
    const orderId = String(x.orderId).trim();
    if (!marketplace || !orderId) continue;
    out.push({ marketplace, orderId });
  }
  return out;
}

function parseSourceOrdersJson(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return normalizeSourceOrderList(raw);
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return normalizeSourceOrderList(Array.isArray(j) ? j : []);
    } catch {
      return [];
    }
  }
  return [];
}

async function mergeSourceOrdersInTx(client, purchaseId, productId, newOrders) {
  const norm = normalizeSourceOrderList(newOrders);
  if (norm.length === 0) return;
  const r = await client.query(
    `SELECT source_orders FROM purchase_items WHERE purchase_id = $1 AND product_id = $2 FOR UPDATE`,
    [purchaseId, productId]
  );
  if (!r.rows?.length) return;
  const existing = parseSourceOrdersJson(r.rows[0].source_orders);
  const key = (o) => `${String(o.marketplace || '').toLowerCase()}|${String(o.orderId ?? '')}`;
  const map = new Map();
  for (const o of existing) {
    const k = key(o);
    if (!k.endsWith('|')) map.set(k, { marketplace: o.marketplace, orderId: String(o.orderId) });
  }
  for (const o of norm) map.set(key(o), { marketplace: o.marketplace, orderId: o.orderId });
  const merged = [...map.values()];
  await client.query(
    `UPDATE purchase_items SET source_orders = $3::jsonb, updated_at = CURRENT_TIMESTAMP WHERE purchase_id = $1 AND product_id = $2`,
    [purchaseId, productId, JSON.stringify(merged)]
  );
}

async function assertProductAllowedInProfile(client, productId, profileId) {
  const pid = normalizeProfileId(profileId);
  if (pid == null) return;
  const res = await client.query(
    `SELECT 1 FROM products p
     LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE p.id = $1
       AND (o.profile_id IS NOT DISTINCT FROM $2::bigint)`,
    [productId, pid]
  );
  if (!res.rows?.length) {
    const err = new Error('Товар недоступен в вашем аккаунте');
    err.statusCode = 403;
    throw err;
  }
}

function nowIso() {
  return new Date().toISOString();
}

/** Увеличить incoming на дельту по операции закупки (создание / добавление количества). */
async function addIncomingDeltaForPurchaseInTx(client, purchaseId, productId, deltaQty, profileId) {
  const d = Math.max(0, parseInt(deltaQty, 10) || 0);
  if (d <= 0) return;
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return;
  await assertProductAllowedInProfile(client, pid, profileId);
  await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [pid]);
  const pr = await client.query('SELECT COALESCE(incoming_quantity, 0) AS inc FROM products WHERE id = $1', [pid]);
  const incoming = pr.rows?.[0]?.inc != null ? Number(pr.rows[0].inc) : 0;
  const newIncoming = incoming + d;
  await client.query(
    'UPDATE products SET incoming_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [newIncoming, pid]
  );
  await client.query(
    `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta)
     VALUES ($1, 'incoming', $2, $3, $4, $5::jsonb)`,
    [
      pid,
      d,
      newIncoming,
      `Закупка №${purchaseId} — ожидание`,
      JSON.stringify({ purchase_id: purchaseId }),
    ]
  );
}

/** Снять incoming по ещё не принятой части удаляемой строки закупки. */
async function subtractIncomingForPurchaseLineRemovalInTx(client, purchaseId, productId, remainderQty) {
  const rem = Math.max(0, parseInt(remainderQty, 10) || 0);
  if (rem <= 0) return;
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return;
  await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [pid]);
  const pr = await client.query('SELECT COALESCE(incoming_quantity, 0) AS inc FROM products WHERE id = $1', [pid]);
  const incoming = pr.rows?.[0]?.inc != null ? Number(pr.rows[0].inc) : 0;
  const newIncoming = Math.max(0, incoming - rem);
  await client.query(
    'UPDATE products SET incoming_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [newIncoming, pid]
  );
  await client.query(
    `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta)
     VALUES ($1, 'incoming', $2, $3, $4, $5::jsonb)`,
    [
      pid,
      -rem,
      newIncoming,
      `Снятие ожидания при удалении строки закупки №${purchaseId}`,
      JSON.stringify({ purchase_id: purchaseId, line_removed: true }),
    ]
  );
}

async function ensureWarehouseReceiptForPurchaseReceiptInTx(client, { purchaseId, purchaseReceiptId } = {}) {
  const pid = Number(purchaseId);
  const rid = Number(purchaseReceiptId);
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(rid) || rid < 1) return null;

  // Правило: ОДНА складская приёмка (warehouse_receipts) на ОДНУ закупку.
  // Если по этой закупке уже есть связанный документ — используем его.
  try {
    const any = await client.query(
      `SELECT warehouse_receipt_id
       FROM purchase_receipts
       WHERE purchase_id = $1 AND warehouse_receipt_id IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
      [pid]
    );
    const whAny = any.rows?.[0]?.warehouse_receipt_id ?? null;
    if (whAny) {
      await client.query(
        `UPDATE purchase_receipts
         SET warehouse_receipt_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [rid, whAny]
      );
      return whAny;
    }
  } catch {
    // ignore
  }

  const cur = await client.query(
    `SELECT warehouse_receipt_id FROM purchase_receipts WHERE id = $1 FOR UPDATE`,
    [rid]
  );
  const existing = cur.rows?.[0]?.warehouse_receipt_id ?? null;
  if (existing) return existing;

  const head = await client.query(`SELECT supplier_id, organization_id FROM purchases WHERE id = $1`, [pid]);
  const supplierId = head.rows?.[0]?.supplier_id ?? null;
  const organizationId = head.rows?.[0]?.organization_id ?? null;

  let warehouseReceiptId = null;
  try {
    const docIns = await client.query(
      `INSERT INTO warehouse_receipts (supplier_id, organization_id, document_type)
       VALUES ($1, $2, 'receipt')
       RETURNING id`,
      [supplierId, organizationId]
    );
    warehouseReceiptId = docIns.rows?.[0]?.id ?? null;
  } catch (e) {
    const msg = String(e?.message || '');
    if (/column.*does not exist|organization_id|document_type/i.test(msg)) {
      const docIns = await client.query(
        `INSERT INTO warehouse_receipts (supplier_id) VALUES ($1) RETURNING id`,
        [supplierId]
      );
      warehouseReceiptId = docIns.rows?.[0]?.id ?? null;
    } else {
      throw e;
    }
  }

  if (warehouseReceiptId) {
    const receiptNumber = `ПТ-${String(warehouseReceiptId).padStart(6, '0')}`;
    try {
      await client.query(
        `UPDATE warehouse_receipts SET receipt_number = $1 WHERE id = $2`,
        [receiptNumber, warehouseReceiptId]
      );
    } catch {
      // ignore
    }
    await client.query(
      `UPDATE purchase_receipts SET warehouse_receipt_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [rid, warehouseReceiptId]
    );
  }

  return warehouseReceiptId;
}

async function backfillWarehouseReceiptLinesFromPurchaseReceiptInTx(client, { purchaseId, purchaseReceiptId, warehouseReceiptId } = {}) {
  const pid = Number(purchaseId);
  const rid = Number(purchaseReceiptId);
  const wid = Number(warehouseReceiptId);
  if (!Number.isFinite(pid) || pid < 1 || !Number.isFinite(rid) || rid < 1 || !Number.isFinite(wid) || wid < 1) return;

  // Берём то, что реально было отсканировано по этой приёмке.
  // Для completed-исторических приёмок этого достаточно, чтобы документ появился в списке «Приёмки» с позициями.
  const hasPrice = await hasPurchasePriceColumn((sql) => client.query(sql));
  const rows = await client.query(
    hasPrice
      ? `SELECT ri.product_id, SUM(ri.scanned_quantity)::int AS qty,
              MAX(pi.purchase_price)::numeric AS cost
         FROM purchase_receipt_items ri
         JOIN purchase_receipts r ON r.id = ri.receipt_id
         LEFT JOIN purchase_items pi ON pi.purchase_id = r.purchase_id AND pi.product_id = ri.product_id
         WHERE ri.receipt_id = $1
         GROUP BY ri.product_id
         HAVING SUM(ri.scanned_quantity) > 0`
      : `SELECT ri.product_id, SUM(ri.scanned_quantity)::int AS qty,
              NULL::numeric AS cost
         FROM purchase_receipt_items ri
         WHERE ri.receipt_id = $1
         GROUP BY ri.product_id
         HAVING SUM(ri.scanned_quantity) > 0`,
    [rid]
  );

  // Перезаписываем строки документа (идемпотентно).
  await client.query(`DELETE FROM warehouse_receipt_lines WHERE receipt_id = $1`, [wid]);
  for (const r of rows.rows || []) {
    const productId = Number(r.product_id);
    const qty = Math.max(1, parseInt(r.qty, 10) || 0);
    if (!productId || qty <= 0) continue;
    const c = r.cost != null ? Number(r.cost) : NaN;
    const cost = Number.isFinite(c) && c >= 0 ? c : null;
    await client.query(
      `INSERT INTO warehouse_receipt_lines (receipt_id, product_id, quantity, cost)
       VALUES ($1, $2, $3, $4)`,
      [wid, productId, qty, cost]
    );
  }
}

function metaIsExtraTrue(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return meta.extra === true || meta.extra === 'true';
}

/** Уменьшить количества в строках warehouse_receipt_lines на totalQty (с конца). */
async function trimWarehouseReceiptLinesQtyInTx(client, whId, productId, totalQty) {
  const wid = Number(whId);
  const pid = Number(productId);
  let remaining = Math.max(0, parseInt(totalQty, 10) || 0);
  if (!Number.isFinite(wid) || wid < 1 || !Number.isFinite(pid) || pid < 1 || remaining <= 0) return;
  while (remaining > 0) {
    const line = await client.query(
      `SELECT id, quantity FROM warehouse_receipt_lines WHERE receipt_id = $1 AND product_id = $2 ORDER BY id DESC LIMIT 1`,
      [wid, pid]
    );
    if (!line.rows?.[0]) break;
    const lid = line.rows[0].id;
    const lq = Math.max(0, parseInt(line.rows[0].quantity, 10) || 0);
    if (lq <= 0) {
      await client.query(`DELETE FROM warehouse_receipt_lines WHERE id = $1`, [lid]);
      continue;
    }
    if (lq <= remaining) {
      await client.query(`DELETE FROM warehouse_receipt_lines WHERE id = $1`, [lid]);
      remaining -= lq;
    } else {
      await client.query(`UPDATE warehouse_receipt_lines SET quantity = $1 WHERE id = $2`, [lq - remaining, lid]);
      remaining = 0;
    }
  }
}

async function maybeDeleteOrphanWarehouseReceiptInTx(client, whId) {
  const wid = Number(whId);
  if (!Number.isFinite(wid) || wid < 1) return;
  const cnt = await client.query(
    `SELECT COUNT(*)::int AS c FROM purchase_receipts WHERE warehouse_receipt_id = $1`,
    [wid]
  );
  if ((cnt.rows?.[0]?.c ?? 0) > 0) return;
  await client.query(`DELETE FROM warehouse_receipt_lines WHERE receipt_id = $1`, [wid]);
  await client.query(`DELETE FROM warehouse_receipts WHERE id = $1`, [wid]);
}

/**
 * Откат остатков по завершённой приёмке (по stock_movements.meta.purchase_receipt_id).
 */
async function reverseCompletedPurchaseReceiptInTx(client, rid, purchaseId) {
  // Только «исходные» проводки документа; строки сторно (reversal_of) не трогаем — нельзя откатить откат.
  const movements = await client.query(
    `SELECT id, product_id, type, quantity_change, warehouse_id, meta
     FROM stock_movements
     WHERE (meta->>'purchase_receipt_id') IS NOT NULL
       AND (meta->>'purchase_receipt_id')::bigint = $1
       AND (meta->>'reversal_of') IS NULL
     ORDER BY id ASC`,
    [rid]
  );
  const rows = movements.rows || [];
  const byProductReceived = new Map();
  const byProductExtra = new Map();
  for (const m of rows) {
    if (m.type !== 'receipt') continue;
    const ch = Number(m.quantity_change);
    if (ch <= 0) continue;
    const pid = Number(m.product_id);
    if (!pid) continue;
    const meta = m.meta || {};
    if (metaIsExtraTrue(meta)) byProductExtra.set(pid, (byProductExtra.get(pid) || 0) + ch);
    else byProductReceived.set(pid, (byProductReceived.get(pid) || 0) + ch);
  }
  for (const m of rows) {
    const pid = Number(m.product_id);
    const ch = Number(m.quantity_change);
    const whRaw = m.warehouse_id;
    const wh = whRaw != null ? Number(whRaw) : null;
    if (m.type === 'receipt' && ch > 0) {
      if (wh && Number.isFinite(wh)) {
        await client.query(
          `UPDATE product_warehouse_stock
           SET quantity = GREATEST(0, COALESCE(quantity, 0) - $1::int)
           WHERE product_id = $2 AND warehouse_id = $3`,
          [ch, pid, wh]
        );
      } else {
        await client.query(
          `UPDATE products SET quantity = GREATEST(0, COALESCE(quantity, 0) - $1::int), updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [ch, pid]
        );
      }
      const balRow = await client.query('SELECT quantity FROM products WHERE id = $1', [pid]);
      const balanceAfter = balRow.rows?.[0]?.quantity != null ? Number(balRow.rows[0].quantity) : 0;
      await client.query(
        `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta, warehouse_id)
         VALUES ($1, 'receipt', $2, $3, $4, $5::jsonb, $6)`,
        [
          pid,
          -ch,
          balanceAfter,
          `Сторно: откат приёмки №${rid}`,
          JSON.stringify({
            storno: true,
            purchase_id: purchaseId,
            purchase_receipt_id: rid,
            reversal_of: m.id,
          }),
          wh && Number.isFinite(wh) ? wh : null,
        ]
      );
    } else if (m.type === 'incoming' && ch < 0) {
      const addBack = -ch;
      await client.query(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [pid]);
      await client.query(
        `UPDATE products SET incoming_quantity = COALESCE(incoming_quantity, 0) + $1::int, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [addBack, pid]
      );
      const incRow = await client.query('SELECT incoming_quantity FROM products WHERE id = $1', [pid]);
      const newInc = incRow.rows?.[0]?.incoming_quantity != null ? Number(incRow.rows[0].incoming_quantity) : 0;
      await client.query(
        `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta, warehouse_id)
         VALUES ($1, 'incoming', $2, $3, $4, $5::jsonb, $6)`,
        [
          pid,
          addBack,
          newInc,
          `Сторно: возврат ожидания (incoming) по приёмке №${rid}`,
          JSON.stringify({
            storno: true,
            purchase_id: purchaseId,
            purchase_receipt_id: rid,
            reversal_of: m.id,
          }),
          wh && Number.isFinite(wh) ? wh : null,
        ]
      );
    }
  }
  for (const [productId, qty] of byProductReceived) {
    await client.query(
      `UPDATE purchase_items
       SET received_quantity = GREATEST(0, COALESCE(received_quantity, 0) - $1::int), updated_at = CURRENT_TIMESTAMP
       WHERE purchase_id = $2 AND product_id = $3`,
      [qty, purchaseId, productId]
    );
  }
  const whHead = await client.query(`SELECT warehouse_receipt_id FROM purchase_receipts WHERE id = $1`, [rid]);
  const whId = whHead.rows?.[0]?.warehouse_receipt_id ?? null;
  if (whId) {
    for (const [productId, qty] of byProductReceived) {
      await trimWarehouseReceiptLinesQtyInTx(client, whId, productId, qty);
    }
    for (const [productId, qty] of byProductExtra) {
      await trimWarehouseReceiptLinesQtyInTx(client, whId, productId, qty);
    }
  }
}

/** Удалить незавершённую приёмку (scanning/draft/cancelled): строки склада и документ. */
async function deleteScanningPurchaseReceiptInTx(client, rid) {
  const head = await client.query(`SELECT id, warehouse_receipt_id FROM purchase_receipts WHERE id = $1 FOR UPDATE`, [rid]);
  if (!head.rows?.[0]) return;
  const whId = head.rows[0].warehouse_receipt_id ?? null;
  const items = await client.query(`SELECT product_id, scanned_quantity FROM purchase_receipt_items WHERE receipt_id = $1`, [rid]);
  if (whId) {
    for (const row of items.rows || []) {
      const pid = Number(row.product_id);
      const sq = Math.max(0, parseInt(row.scanned_quantity, 10) || 0);
      if (pid && sq > 0) await trimWarehouseReceiptLinesQtyInTx(client, whId, pid, sq);
    }
  }
  await client.query(`DELETE FROM purchase_receipts WHERE id = $1`, [rid]);
  await maybeDeleteOrphanWarehouseReceiptInTx(client, whId);
}

async function recalcPurchaseStatusAfterReceiptChangeInTx(client, purchaseId) {
  await client.query(`UPDATE purchases SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [purchaseId]);
}

/** Снять ожидание (incoming), которое осталось по строкам закупки (после отката приёмок). */
async function removeRemainingIncomingForPurchaseInTx(client, purchaseId) {
  const lines = await client.query(
    `SELECT product_id, expected_quantity, received_quantity FROM purchase_items WHERE purchase_id = $1 FOR UPDATE`,
    [purchaseId]
  );
  for (const row of lines.rows || []) {
    const productId = Number(row.product_id);
    const expected = row.expected_quantity != null ? Number(row.expected_quantity) : 0;
    const received = row.received_quantity != null ? Number(row.received_quantity) : 0;
    const rem = Math.max(0, expected - received);
    if (!productId || rem <= 0) continue;
    await client.query(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [productId]);
    const pr = await client.query(`SELECT COALESCE(incoming_quantity, 0) AS inc FROM products WHERE id = $1`, [productId]);
    const incoming = pr.rows?.[0]?.inc != null ? Number(pr.rows[0].inc) : 0;
    const newIncoming = Math.max(0, incoming - rem);
    await client.query(
      `UPDATE products SET incoming_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [newIncoming, productId]
    );
    await client.query(
      `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta)
       VALUES ($1, 'incoming', $2, $3, $4, $5::jsonb)`,
      [
        productId,
        -rem,
        newIncoming,
        `Сторно: снятие ожидания при удалении закупки №${purchaseId}`,
        JSON.stringify({ storno: true, purchase_id: purchaseId, purchase_deleted: true }),
      ]
    );
  }
}

async function collectAllSourceOrdersFromPurchaseInTx(client, purchaseId) {
  const rows = await client.query(`SELECT source_orders FROM purchase_items WHERE purchase_id = $1`, [purchaseId]);
  const out = [];
  for (const row of rows.rows || []) {
    out.push(...parseSourceOrdersJson(row.source_orders));
  }
  return out;
}

/**
 * Осталась ли привязка заказа к любой активной закупке профиля (кроме целиком исключаемой закупки).
 */
async function orderHasActivePurchaseReferenceExceptPurchase(
  client,
  profileId,
  marketplace,
  orderId,
  excludePurchaseId = null
) {
  const pid = normalizeProfileId(profileId);
  const oid = String(orderId ?? '').trim();
  if (pid == null || !oid) return false;
  const wantDbMp = orderMarketplaceToDb(marketplace);

  const res = await client.query(
    `SELECT pi.source_orders
     FROM purchase_items pi
     INNER JOIN purchases p ON p.id = pi.purchase_id
     WHERE p.profile_id = $1
       AND ($2::bigint IS NULL OR p.id IS DISTINCT FROM $2::bigint)
       AND EXISTS (
         SELECT 1 FROM purchase_items x
         WHERE x.purchase_id = p.id
           AND x.expected_quantity > COALESCE(x.received_quantity, 0)
       )`,
    [pid, excludePurchaseId]
  );
  for (const row of res.rows || []) {
    for (const ent of parseSourceOrdersJson(row.source_orders)) {
      if (String(ent.orderId ?? '').trim() !== oid) continue;
      if (orderMarketplaceToDb(ent.marketplace) === wantDbMp) return true;
    }
  }
  return false;
}

/**
 * Вернуть заказы из «В закупке» в «Новый» по списку source_orders.
 * - Не трогаем заказ, если он всё ещё фигурирует в другой активной закупке этого профиля.
 * - Для строк с общим order_group_id (WB orderUid, группы Яндекса и т.д.) откатываем всю группу.
 */
async function revertInProcurementOrdersFromSourceListInTx(client, sourceList, { profileId, excludePurchaseId } = {}) {
  const seenGroup = new Set();
  const seenSingle = new Set();
  for (const o of sourceList || []) {
    if (!o?.marketplace || o?.orderId == null) continue;
    const dbMp = orderMarketplaceToDb(o.marketplace);
    const oid = String(o.orderId);
    if (profileId != null) {
      const stillLinked = await orderHasActivePurchaseReferenceExceptPurchase(
        client,
        profileId,
        o.marketplace,
        o.orderId,
        excludePurchaseId ?? null
      );
      if (stillLinked) continue;
    }

    const found = await client.query(
      `SELECT order_group_id FROM orders WHERE marketplace = $1 AND order_id = $2 AND status = 'in_procurement' LIMIT 1`,
      [dbMp, oid]
    );
    const gidRaw = found.rows?.[0]?.order_group_id;
    const gid = gidRaw != null && String(gidRaw).trim() !== '' ? String(gidRaw).trim() : '';

    if (gid) {
      const gk = `${dbMp}|g:${gid}`;
      if (seenGroup.has(gk)) continue;
      seenGroup.add(gk);
      await client.query(
        `UPDATE orders SET
           status = 'new',
           returned_to_new_at = CURRENT_TIMESTAMP,
           assembled_at = NULL,
           assembled_by_user_id = NULL,
           updated_at = CURRENT_TIMESTAMP
         WHERE marketplace = $1 AND order_group_id = $2::text AND status = 'in_procurement'`,
        [dbMp, gid]
      );
      continue;
    }

    const sk = `${dbMp}|o:${oid}`;
    if (seenSingle.has(sk)) continue;
    seenSingle.add(sk);
    await client.query(
      `UPDATE orders SET
         status = 'new',
         returned_to_new_at = CURRENT_TIMESTAMP,
         assembled_at = NULL,
         assembled_by_user_id = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE marketplace = $1 AND order_id = $2 AND status = 'in_procurement'`,
      [dbMp, oid]
    );
  }
}

/** Снять резерв по заказу(ам): при наличии order_group_id обходим все строки группы (WB / Яндекс). */
async function releaseReservesAfterRevertForSourceOrder(marketplace, orderId) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    await ordersService.releaseReserveIfExistsForOrder(marketplace, orderId);
    return;
  }
  const repo = repositoryFactory.getOrdersRepository();
  const row = await repo.findByMarketplaceAndOrderId(marketplace, String(orderId));
  if (!row) return;
  const gid = row.orderGroupId ?? row.order_group_id;
  const rows =
    gid != null && String(gid).trim() !== ''
      ? await repo.findByOrderGroupId(String(gid))
      : [row];
  for (const r of rows || []) {
    const st = r.status;
    if (st === 'in_procurement') continue;
    await ordersService.releaseReserveIfExistsForOrder(r.marketplace, r.orderId ?? r.order_id);
  }
}

class PurchasesService {
  async updatePurchase(
    purchaseId,
    { supplierId = null, organizationId = null, warehouseId = null, note = null } = {},
    { profileId } = {}
  ) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const id = parseInt(purchaseId, 10);
    if (!id || Number.isNaN(id)) {
      const err = new Error('Некорректный ID закупки');
      err.statusCode = 400;
      throw err;
    }
    const supplier =
      supplierId === '' || supplierId == null ? null : Number.isNaN(Number(supplierId)) ? null : Number(supplierId);
    const org =
      organizationId === '' || organizationId == null
        ? null
        : Number.isNaN(Number(organizationId))
          ? null
          : Number(organizationId);
    const wid =
      warehouseId === '' || warehouseId == null ? null : Number.isNaN(Number(warehouseId)) ? null : Number(warehouseId);

    return transaction(async (client) => {
      await assertPurchaseInProfile(client, id, pid);
      await client.query(
        `UPDATE purchases
         SET supplier_id = $2,
             organization_id = COALESCE($3, organization_id),
             warehouse_id = COALESCE($4, warehouse_id),
             note = COALESCE($5, note),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, supplier, org, wid, note]
      );
      return { ok: true, id, supplierId: supplier };
    });
  }

  async updatePurchaseItem(purchaseId, itemId, { purchasePrice } = {}, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const purId = parseInt(purchaseId, 10);
    const lineId = parseInt(itemId, 10);
    if (!purId || Number.isNaN(purId) || !lineId || Number.isNaN(lineId)) {
      const err = new Error('Некорректный ID');
      err.statusCode = 400;
      throw err;
    }
    const ppRaw = purchasePrice;
    const pp = ppRaw === '' || ppRaw == null ? null : Number(ppRaw);
    if (pp != null && (Number.isNaN(pp) || pp < 0)) {
      const err = new Error('Некорректная закупочная цена');
      err.statusCode = 400;
      throw err;
    }

    return transaction(async (client) => {
      await assertPurchaseInProfile(client, purId, pid);
      const hasPrice = await hasPurchasePriceColumn((sql) => client.query(sql));
      if (!hasPrice) {
        const err = new Error('В базе не найдено поле закупочной цены. Примените миграцию 078_add_purchase_price_to_purchase_items.sql');
        err.statusCode = 400;
        throw err;
      }
      const r = await client.query(
        `UPDATE purchase_items
         SET purchase_price = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND purchase_id = $1
         RETURNING id, purchase_id, product_id, purchase_price`,
        [purId, lineId, pp]
      );
      if (!r.rows?.length) {
        const err = new Error('Строка закупки не найдена');
        err.statusCode = 404;
        throw err;
      }
      return { ok: true, item: r.rows[0] };
    });
  }

  async list({ profileId, limit = 200, status = null } = {}) {
    const lim = Math.min(Math.max(1, parseInt(limit, 10) || 200), 500);
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const st = status != null && String(status).trim() !== '' ? String(status).trim() : null;
    const params = [pid];
    let whereExtra = '';
    if (st) {
      params.push(st);
      whereExtra = ` AND p.status = $${params.length}`;
    }
    params.push(lim);
    const limParam = `$${params.length}`;
    const r = await query(
      `SELECT p.id, p.created_at, p.updated_at, p.ordered_at, p.completed_at,
              p.status, p.supplier_id, p.organization_id, p.warehouse_id, p.note,
              s.name AS supplier_name,
              o.name AS organization_name,
              COALESCE(w.address, '') AS warehouse_name,
              COALESCE(agg.cnt, 0)::int AS items_count,
              COALESCE(agg.exp_sum, 0)::int AS expected_total,
              COALESCE(agg.rec_sum, 0)::int AS received_total
       FROM purchases p
       LEFT JOIN (
         SELECT purchase_id,
                COUNT(*)::int AS cnt,
                COALESCE(SUM(expected_quantity), 0)::int AS exp_sum,
                COALESCE(SUM(COALESCE(received_quantity, 0)), 0)::int AS rec_sum
         FROM purchase_items
         GROUP BY purchase_id
       ) agg ON agg.purchase_id = p.id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN organizations o ON o.id = p.organization_id
       LEFT JOIN warehouses w ON w.id = p.warehouse_id
       WHERE p.profile_id = $1${whereExtra}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${limParam}`,
      params
    );
    const rows = r.rows || [];
    return rows.map((row) => ({
      ...row,
      items_count: row.items_count != null ? Number(row.items_count) : 0,
      expected_total: row.expected_total != null ? Number(row.expected_total) : 0,
      received_total: row.received_total != null ? Number(row.received_total) : 0,
    }));
  }

  async getById(purchaseId, { profileId } = {}) {
    const id = parseInt(purchaseId, 10);
    if (!id || Number.isNaN(id)) {
      const err = new Error('Некорректный ID закупки');
      err.statusCode = 400;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const head = await query(
      `SELECT p.*,
              s.name AS supplier_name,
              o.name AS organization_name,
              COALESCE(w.address, '') AS warehouse_name
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN organizations o ON o.id = p.organization_id
       LEFT JOIN warehouses w ON w.id = p.warehouse_id
       WHERE p.id = $1 AND p.profile_id = $2`,
      [id, pid]
    );
    const purchase = head.rows?.[0];
    if (!purchase) {
      const err = new Error('Закупка не найдена');
      err.statusCode = 404;
      throw err;
    }
    const hasPrice = await hasPurchasePriceColumn(query);
    const lines = await query(
      hasPrice
        ? `SELECT i.id, i.product_id, i.expected_quantity, i.received_quantity, i.source_orders,
                i.purchase_price,
                p.sku AS product_sku, p.name AS product_name, p.cost AS product_cost
           FROM purchase_items i
           JOIN products p ON p.id = i.product_id
           WHERE i.purchase_id = $1
           ORDER BY i.id ASC`
        : `SELECT i.id, i.product_id, i.expected_quantity, i.received_quantity, i.source_orders,
                NULL::numeric AS purchase_price,
                p.sku AS product_sku, p.name AS product_name, p.cost AS product_cost
           FROM purchase_items i
           JOIN products p ON p.id = i.product_id
           WHERE i.purchase_id = $1
           ORDER BY i.id ASC`,
      [id]
    );
    let receipts;
    try {
      receipts = await query(
        `SELECT r.id, r.created_at, r.status, r.started_at, r.completed_at,
                r.warehouse_receipt_id,
                (SELECT COUNT(*) FROM purchase_receipt_items ri WHERE ri.receipt_id = r.id) AS items_count
         FROM purchase_receipts r
         WHERE r.purchase_id = $1
           AND r.status = 'completed'
         ORDER BY r.created_at DESC, r.id DESC`,
        [id]
      );
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg.includes('warehouse_receipt_id') && msg.includes('does not exist')) {
        receipts = await query(
          `SELECT r.id, r.created_at, r.status, r.started_at, r.completed_at,
                  NULL::bigint AS warehouse_receipt_id,
                  (SELECT COUNT(*) FROM purchase_receipt_items ri WHERE ri.receipt_id = r.id) AS items_count
           FROM purchase_receipts r
           WHERE r.purchase_id = $1
             AND r.status = 'completed'
           ORDER BY r.created_at DESC, r.id DESC`,
          [id]
        );
      } else {
        throw e;
      }
    }

    // Backfill для старых приёмок: создаём складской документ, если его не было (чтобы появился в разделе «Приёмки»).
    const receiptRows = receipts.rows || [];
    const missing = receiptRows.filter((r) => r?.id && !r.warehouse_receipt_id);
    if (missing.length > 0) {
      try {
        await transaction(async (client) => {
          await assertPurchaseInProfile(client, id, pid);
          for (const r of missing) {
            const whId = await ensureWarehouseReceiptForPurchaseReceiptInTx(client, { purchaseId: id, purchaseReceiptId: r.id });
            if (whId && (r.status === 'completed' || (r.items_count != null && Number(r.items_count) > 0))) {
              await backfillWarehouseReceiptLinesFromPurchaseReceiptInTx(client, {
                purchaseId: id,
                purchaseReceiptId: r.id,
                warehouseReceiptId: whId
              });
            }
          }
        });
      } catch {
        // ignore
      }
    }

    // Перечитываем список (чтобы вернуть warehouse_receipt_id после backfill)
    let receipts2;
    try {
      receipts2 = await query(
        `SELECT r.id, r.created_at, r.status, r.started_at, r.completed_at,
                r.warehouse_receipt_id,
                (SELECT COUNT(*) FROM purchase_receipt_items ri WHERE ri.receipt_id = r.id) AS items_count
         FROM purchase_receipts r
         WHERE r.purchase_id = $1
           AND r.status = 'completed'
         ORDER BY r.created_at DESC, r.id DESC`,
        [id]
      );
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg.includes('warehouse_receipt_id') && msg.includes('does not exist')) {
        receipts2 = await query(
          `SELECT r.id, r.created_at, r.status, r.started_at, r.completed_at,
                  NULL::bigint AS warehouse_receipt_id,
                  (SELECT COUNT(*) FROM purchase_receipt_items ri WHERE ri.receipt_id = r.id) AS items_count
           FROM purchase_receipts r
           WHERE r.purchase_id = $1
             AND r.status = 'completed'
           ORDER BY r.created_at DESC, r.id DESC`,
          [id]
        );
      } else {
        throw e;
      }
    }

    return { purchase, items: lines.rows || [], receipts: receipts2.rows || [] };
  }

  /**
   * Создать закупку с позициями: сразу incoming по добавленным количествам.
   * items: [{ productId, quantity }]
   */
  async create(
    { supplierId = null, organizationId = null, warehouseId = null, items = [], note = null } = {},
    { userId, profileId } = {}
  ) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const uid = userId != null ? parseInt(userId, 10) : null;
    const supplier = supplierId != null && supplierId !== '' ? Number(supplierId) : null;
    const org = organizationId != null && organizationId !== '' ? Number(organizationId) : null;
    const wid = warehouseId != null && warehouseId !== '' ? Number(warehouseId) : null;
    const list = Array.isArray(items) ? items : [];
    const normalized = list
      .map((it) => ({
        productId: parseInt(it?.productId, 10),
        qty: Math.max(1, parseInt(it?.quantity ?? it?.qty, 10) || 1),
        sourceOrders: normalizeSourceOrderList(it?.sourceOrders),
      }))
      .filter((it) => it.productId && !Number.isNaN(it.productId));
    if (normalized.length === 0) {
      const err = new Error('Добавьте хотя бы одну позицию (items)');
      err.statusCode = 400;
      throw err;
    }

    return transaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO purchases (supplier_id, organization_id, warehouse_id, profile_id, created_by_user_id, status, ordered_at, note)
         VALUES ($1, $2, $3, $4, $5, 'open', CURRENT_TIMESTAMP, $6)
         RETURNING id`,
        [supplier, org, wid, pid, uid && !Number.isNaN(uid) ? uid : null, note || null]
      );
      const purchaseId = ins.rows[0].id;
      const hasPrice = await hasPurchasePriceColumn((sql) => client.query(sql));

      for (const it of normalized) {
        await assertProductAllowedInProfile(client, it.productId, pid);
        if (hasPrice) {
          await client.query(
            `INSERT INTO purchase_items (purchase_id, product_id, expected_quantity, received_quantity, source_orders, purchase_price)
             VALUES ($1, $2, $3, 0, '[]'::jsonb, (SELECT cost FROM products WHERE id = $2))
             ON CONFLICT (purchase_id, product_id)
             DO UPDATE SET
               expected_quantity = purchase_items.expected_quantity + EXCLUDED.expected_quantity,
               updated_at = CURRENT_TIMESTAMP`,
            [purchaseId, it.productId, it.qty]
          );
        } else {
          await client.query(
            `INSERT INTO purchase_items (purchase_id, product_id, expected_quantity, received_quantity, source_orders)
             VALUES ($1, $2, $3, 0, '[]'::jsonb)
             ON CONFLICT (purchase_id, product_id)
             DO UPDATE SET
               expected_quantity = purchase_items.expected_quantity + EXCLUDED.expected_quantity,
               updated_at = CURRENT_TIMESTAMP`,
            [purchaseId, it.productId, it.qty]
          );
        }
        await mergeSourceOrdersInTx(client, purchaseId, it.productId, it.sourceOrders);
        await addIncomingDeltaForPurchaseInTx(client, purchaseId, it.productId, it.qty, pid);
      }

      return { id: purchaseId };
    });
  }

  /**
   * Добавить позиции в закупку (суммируя количество при совпадении товара); incoming — по добавленной дельте.
   * @param {number} purchaseId
   * @param {{ items: { productId, quantity|qty }[] }} payload
   */
  async appendDraftItems(purchaseId, { items = [] } = {}, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const id = parseInt(purchaseId, 10);
    if (!id || Number.isNaN(id)) {
      const err = new Error('Некорректный ID закупки');
      err.statusCode = 400;
      throw err;
    }
    const list = Array.isArray(items) ? items : [];
    const normalized = list
      .map((it) => ({
        productId: parseInt(it?.productId, 10),
        qty: Math.max(1, parseInt(it?.quantity ?? it?.qty, 10) || 1),
        sourceOrders: normalizeSourceOrderList(it?.sourceOrders),
      }))
      .filter((it) => it.productId && !Number.isNaN(it.productId));
    if (normalized.length === 0) {
      const err = new Error('Добавьте хотя бы одну позицию (items)');
      err.statusCode = 400;
      throw err;
    }

    return transaction(async (client) => {
      await assertPurchaseInProfile(client, id, pid);
      const head = await client.query('SELECT id FROM purchases WHERE id = $1 FOR UPDATE', [id]);
      if (!head.rows?.[0]) {
        const err = new Error('Закупка не найдена');
        err.statusCode = 404;
        throw err;
      }

      const hasPrice = await hasPurchasePriceColumn((sql) => client.query(sql));

      for (const it of normalized) {
        await assertProductAllowedInProfile(client, it.productId, pid);
        if (hasPrice) {
          await client.query(
            `INSERT INTO purchase_items (purchase_id, product_id, expected_quantity, received_quantity, source_orders, purchase_price)
             VALUES ($1, $2, $3, 0, '[]'::jsonb, (SELECT cost FROM products WHERE id = $2))
             ON CONFLICT (purchase_id, product_id)
             DO UPDATE SET
               expected_quantity = purchase_items.expected_quantity + EXCLUDED.expected_quantity,
               updated_at = CURRENT_TIMESTAMP`,
            [id, it.productId, it.qty]
          );
        } else {
          await client.query(
            `INSERT INTO purchase_items (purchase_id, product_id, expected_quantity, received_quantity, source_orders)
             VALUES ($1, $2, $3, 0, '[]'::jsonb)
             ON CONFLICT (purchase_id, product_id)
             DO UPDATE SET
               expected_quantity = purchase_items.expected_quantity + EXCLUDED.expected_quantity,
               updated_at = CURRENT_TIMESTAMP`,
            [id, it.productId, it.qty]
          );
        }
        await mergeSourceOrdersInTx(client, id, it.productId, it.sourceOrders);
        await addIncomingDeltaForPurchaseInTx(client, id, it.productId, it.qty, pid);
      }

      await client.query(
        `UPDATE purchases SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id]
      );
      return { ok: true, id };
    });
  }

  /**
   * Удалить строку закупки (только непринятый остаток): снять incoming, связанные заказы → «Новый» при отсутствии другой закупки.
   */
  async removeDraftLineItem(purchaseId, itemId, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const purId = parseInt(purchaseId, 10);
    const lineId = parseInt(itemId, 10);
    if (!purId || Number.isNaN(purId) || !lineId || Number.isNaN(lineId)) {
      const err = new Error('Некорректный ID');
      err.statusCode = 400;
      throw err;
    }

    let sourceList = [];

    await transaction(async (client) => {
      await assertPurchaseInProfile(client, purId, pid);
      const ph = await client.query('SELECT id FROM purchases WHERE id = $1 FOR UPDATE', [purId]);
      if (!ph.rows?.[0]) {
        const err = new Error('Закупка не найдена');
        err.statusCode = 404;
        throw err;
      }

      const line = await client.query(
        `SELECT id, product_id, source_orders, expected_quantity, received_quantity FROM purchase_items WHERE id = $1 AND purchase_id = $2 FOR UPDATE`,
        [lineId, purId]
      );
      const row = line.rows?.[0];
      if (!row) {
        const err = new Error('Строка закупки не найдена');
        err.statusCode = 404;
        throw err;
      }
      const rec = Math.max(0, parseInt(row.received_quantity, 10) || 0);
      if (rec > 0) {
        const err = new Error('Нельзя удалить строку с уже принятым количеством');
        err.statusCode = 400;
        throw err;
      }

      const expected = Math.max(0, parseInt(row.expected_quantity, 10) || 0);
      const remIncoming = Math.max(0, expected - rec);
      const productId = Number(row.product_id);
      if (remIncoming > 0 && productId) {
        await subtractIncomingForPurchaseLineRemovalInTx(client, purId, productId, remIncoming);
      }

      sourceList = parseSourceOrdersJson(row.source_orders);

      await client.query(`DELETE FROM purchase_items WHERE id = $1`, [lineId]);

      await revertInProcurementOrdersFromSourceListInTx(client, sourceList, { profileId: pid });
    });

    const uniqRel = new Map();
    for (const o of sourceList) {
      const k = `${String(o.marketplace || '').toLowerCase()}|${String(o.orderId ?? '')}`;
      if (!k.endsWith('|')) uniqRel.set(k, o);
    }
    for (const o of uniqRel.values()) {
      await releaseReservesAfterRevertForSourceOrder(o.marketplace, o.orderId);
    }

    return { ok: true, returnedOrders: sourceList };
  }

  /**
   * Актуализировать резервы по заказам из строк закупки.
   * Incoming начисляется при создании/добавлении строк; для старых БД без ordered_at — однократный догон по остатку строк.
   */
  async markOrdered(purchaseId, { userId, profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const id = parseInt(purchaseId, 10);
    if (!id || Number.isNaN(id)) {
      const err = new Error('Некорректный ID закупки');
      err.statusCode = 400;
      throw err;
    }

    let ensureReserves = [];
    const res = await transaction(async (client) => {
      await assertPurchaseInProfile(client, id, pid);
      const head = await client.query(
        'SELECT id, ordered_at FROM purchases WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!head.rows?.[0]) {
        const err = new Error('Закупка не найдена');
        err.statusCode = 404;
        throw err;
      }
      const orderedAt = head.rows[0].ordered_at;
      const items = await client.query(
        'SELECT product_id, expected_quantity, received_quantity, source_orders FROM purchase_items WHERE purchase_id = $1',
        [id]
      );

      const ordersToReserve = [];
      for (const row of items.rows || []) {
        const list = parseSourceOrdersJson(row.source_orders);
        for (const o of list) {
          if (!o?.marketplace || o?.orderId == null) continue;
          ordersToReserve.push({ marketplace: o.marketplace, orderId: String(o.orderId) });
        }
      }
      ensureReserves = ordersToReserve;

      if (!orderedAt) {
        for (const row of items.rows || []) {
          const productId = Number(row.product_id);
          const expected = Math.max(0, parseInt(row.expected_quantity, 10) || 0);
          const received = Math.max(0, parseInt(row.received_quantity, 10) || 0);
          const remaining = Math.max(0, expected - received);
          if (remaining === 0) continue;
          await addIncomingDeltaForPurchaseInTx(client, id, productId, remaining, pid);
        }
        await client.query(
          `UPDATE purchases SET ordered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id]
        );
      }

      return { ok: true, status: 'open', ensuredReserveOrders: ordersToReserve.length };
    });
    // После транзакции: входящий товар должен быть "в резерве" под заказы из «В закупку».
    // Резерв идемпотентен (проверяется по meta.order_id).
    const uniq = new Map();
    for (const o of ensureReserves || []) {
      const k = `${String(o.marketplace || '').toLowerCase()}|${String(o.orderId ?? '')}`;
      if (!k.endsWith('|')) uniq.set(k, o);
    }
    for (const o of uniq.values()) {
      await ordersService.ensureReserveForOrderIfInProcurement(o.marketplace, o.orderId);
    }
    return res;
  }

  /** Создать приёмку по закупке (scanning) */
  async createReceiptFromPurchase(purchaseId, { userId, profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const id = parseInt(purchaseId, 10);
    if (!id || Number.isNaN(id)) {
      const err = new Error('Некорректный ID закупки');
      err.statusCode = 400;
      throw err;
    }
    const uid = userId != null ? parseInt(userId, 10) : null;

    return transaction(async (client) => {
      await assertPurchaseInProfile(client, id, pid);

      // Не плодим "пустые" scanning-приёмки: если уже есть активная — переиспользуем её.
      const existing = await client.query(
        `SELECT r.id, r.warehouse_receipt_id
         FROM purchase_receipts r
         WHERE r.purchase_id = $1
           AND r.status = 'scanning'
         ORDER BY r.id DESC
         LIMIT 1`,
        [id]
      );
      if (existing.rows?.[0]?.id) {
        // Черновик сканирования не должен создавать "сохранённую" приёмку/документ до завершения.
        return { id: existing.rows[0].id, reused: true, warehouseReceiptId: null };
      }

      const ins = await client.query(
        `INSERT INTO purchase_receipts (purchase_id, status, started_at, created_by_user_id)
         VALUES ($1, 'scanning', CURRENT_TIMESTAMP, $2)
         RETURNING id`,
        [id, uid && !Number.isNaN(uid) ? uid : null]
      );
      return { id: ins.rows[0].id, warehouseReceiptId: null };
    });
  }

  /** Получить приёмку с позициями */
  async getReceiptById(receiptId, { profileId } = {}) {
    const rid = parseInt(receiptId, 10);
    if (!rid || Number.isNaN(rid)) {
      const err = new Error('Некорректный ID приёмки');
      err.statusCode = 400;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const head = await query(
      `SELECT r.*,
              p.profile_id,
              p.supplier_id,
              s.name AS supplier_name,
              p.organization_id,
              o.name AS organization_name
       FROM purchase_receipts r
       JOIN purchases p ON p.id = r.purchase_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE r.id = $1 AND p.profile_id = $2`,
      [rid, pid]
    );
    const receipt = head.rows?.[0];
    if (!receipt) {
      const err = new Error('Приёмка не найдена');
      err.statusCode = 404;
      throw err;
    }
    const hasPrice = await hasPurchasePriceColumn(query);
    const lines = await query(
      hasPrice
        ? `SELECT i.id, i.product_id, i.scanned_quantity,
                pi.id AS purchase_item_id,
                pi.purchase_price,
                pi.expected_quantity,
                pi.received_quantity,
                pr.sku AS product_sku, pr.name AS product_name, pr.cost AS product_cost
           FROM purchase_receipt_items i
           JOIN purchase_receipts r ON r.id = i.receipt_id
           LEFT JOIN purchase_items pi ON pi.purchase_id = r.purchase_id AND pi.product_id = i.product_id
           JOIN products pr ON pr.id = i.product_id
           WHERE i.receipt_id = $1
           ORDER BY i.id ASC`
        : `SELECT i.id, i.product_id, i.scanned_quantity,
                pi.id AS purchase_item_id,
                NULL::numeric AS purchase_price,
                pi.expected_quantity,
                pi.received_quantity,
                pr.sku AS product_sku, pr.name AS product_name, pr.cost AS product_cost
           FROM purchase_receipt_items i
           JOIN purchase_receipts r ON r.id = i.receipt_id
           LEFT JOIN purchase_items pi ON pi.purchase_id = r.purchase_id AND pi.product_id = i.product_id
           JOIN products pr ON pr.id = i.product_id
           WHERE i.receipt_id = $1
           ORDER BY i.id ASC`,
      [rid]
    );
    return {
      receipt,
      purchase: {
        id: receipt.purchase_id,
        supplierId: receipt.supplier_id,
        supplierName: receipt.supplier_name,
        organizationId: receipt.organization_id,
        organizationName: receipt.organization_name,
      },
      items: lines.rows || [],
    };
  }

  /** Сканирование: +1 по товару (по productId или barcode) */
  async scanToReceipt(receiptId, { productId = null, barcode = null, sku = null } = {}, { profileId } = {}) {
    const rid = parseInt(receiptId, 10);
    if (!rid || Number.isNaN(rid)) {
      const err = new Error('Некорректный ID приёмки');
      err.statusCode = 400;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const pidNum = productId != null ? parseInt(productId, 10) : null;
    const bc = barcode != null ? String(barcode).trim() : '';
    const skuStr = sku != null ? String(sku).trim() : '';

    // Серверная защита от дублей
    const k = scanKey(rid, bc, skuStr || String(pidNum || ''));
    if (shouldIgnoreDuplicateScan(k)) {
      return { ok: true, ignoredDuplicate: true };
    }

    return transaction(async (client) => {
      // lock receipt row
      const r = await client.query(
        `SELECT r.id, r.status, r.purchase_id
         FROM purchase_receipts r
         JOIN purchases p ON p.id = r.purchase_id
         WHERE r.id = $1 AND p.profile_id = $2
         FOR UPDATE`,
        [rid, pid]
      );
      const receipt = r.rows?.[0];
      if (!receipt) {
        const err = new Error('Приёмка не найдена');
        err.statusCode = 404;
        throw err;
      }
      if (receipt.status !== 'scanning') {
        const err = new Error('Сканирование доступно только для приёмки в статусе scanning');
        err.statusCode = 400;
        throw err;
      }

      let resolvedProductId = pidNum;
      if (!resolvedProductId && bc) {
        const bcDigits = bc.replace(/\D+/g, '');
        const br = await client.query(
          `SELECT product_id
           FROM barcodes
           WHERE TRIM(barcode) = TRIM($1)
              OR REGEXP_REPLACE(barcode, '\\D', '', 'g') = $2
           LIMIT 1`,
          [bc, bcDigits]
        );
        if (br.rows?.[0]?.product_id) resolvedProductId = Number(br.rows[0].product_id);
      }
      if (!resolvedProductId && skuStr) {
        const pr = await client.query('SELECT id FROM products WHERE sku = $1 LIMIT 1', [skuStr]);
        if (pr.rows?.[0]?.id) resolvedProductId = Number(pr.rows[0].id);
      }
      if (!resolvedProductId && bc) {
        // fallback: иногда штрихкод хранится в SKU (или сканер шлёт EAN13, а SKU=EAN13)
        const pr = await client.query('SELECT id FROM products WHERE sku = $1 LIMIT 1', [bc]);
        if (pr.rows?.[0]?.id) resolvedProductId = Number(pr.rows[0].id);
      }
      if (!resolvedProductId) {
        const err = new Error('Товар не найден по скану');
        err.statusCode = 404;
        throw err;
      }
      await assertProductAllowedInProfile(client, resolvedProductId, pid);

      const up = await client.query(
        `INSERT INTO purchase_receipt_items (receipt_id, product_id, scanned_quantity)
         VALUES ($1, $2, 1)
         ON CONFLICT (receipt_id, product_id)
         DO UPDATE SET scanned_quantity = purchase_receipt_items.scanned_quantity + 1, updated_at = CURRENT_TIMESTAMP
         RETURNING scanned_quantity`,
        [rid, resolvedProductId]
      );
      const scanned = up.rows?.[0]?.scanned_quantity ?? 0;
      return { ok: true, productId: resolvedProductId, scannedQuantity: scanned };
    });
  }

  /** Завершить приёмку: перенести incoming→actual по факту, обновить purchase_items.received_quantity и статусы */
  async completeReceipt(receiptId, { profileId, userId, warehouseId } = {}) {
    const rid = parseInt(receiptId, 10);
    if (!rid || Number.isNaN(rid)) {
      const err = new Error('Некорректный ID приёмки');
      err.statusCode = 400;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }

    return transaction(async (client) => {
      const r = await client.query(
        `SELECT r.id, r.status, r.purchase_id
         FROM purchase_receipts r
         JOIN purchases p ON p.id = r.purchase_id
         WHERE r.id = $1 AND p.profile_id = $2
         FOR UPDATE`,
        [rid, pid]
      );
      const receipt = r.rows?.[0];
      if (!receipt) {
        const err = new Error('Приёмка не найдена');
        err.statusCode = 404;
        throw err;
      }
      if (receipt.status !== 'scanning') {
        const err = new Error('Приёмку можно завершить только из статуса scanning');
        err.statusCode = 400;
        throw err;
      }

      const purchaseId = Number(receipt.purchase_id);
      await assertPurchaseInProfile(client, purchaseId, pid);

      // lock purchase
      const pHead = await client.query('SELECT id FROM purchases WHERE id = $1 FOR UPDATE', [purchaseId]);
      if (!pHead.rows?.[0]) {
        const err = new Error('Закупка не найдена');
        err.statusCode = 404;
        throw err;
      }

      const scanLines = await client.query(
        'SELECT product_id, scanned_quantity FROM purchase_receipt_items WHERE receipt_id = $1',
        [rid]
      );

      const byProduct = new Map();
      for (const row of scanLines.rows || []) {
        const productId = Number(row.product_id);
        const qty = Math.max(0, parseInt(row.scanned_quantity, 10) || 0);
        if (!productId || qty <= 0) continue;
        byProduct.set(productId, qty);
      }

      const receiptWarehouseId = await resolveReceiptWarehouseIdForTx(client, warehouseId);

      // apply per product
      const deltas = [];
      const extras = [];
      for (const [productId, scannedQty] of byProduct.entries()) {
        await assertProductAllowedInProfile(client, productId, pid);

        // expected remaining from purchase
        const pi = await client.query(
          'SELECT expected_quantity, received_quantity FROM purchase_items WHERE purchase_id = $1 AND product_id = $2 FOR UPDATE',
          [purchaseId, productId]
        );
        const expected = pi.rows?.[0]?.expected_quantity != null ? Number(pi.rows[0].expected_quantity) : 0;
        const received = pi.rows?.[0]?.received_quantity != null ? Number(pi.rows[0].received_quantity) : 0;
        const remainingExpected = Math.max(0, expected - received);

        const pr = await client.query(
          'SELECT quantity, incoming_quantity FROM products WHERE id = $1 FOR UPDATE',
          [productId]
        );
        if (!pr.rows?.[0]) continue;
        const actual = pr.rows[0].quantity != null ? Number(pr.rows[0].quantity) : 0;
        const incoming = pr.rows[0].incoming_quantity != null ? Number(pr.rows[0].incoming_quantity) : 0;

        // move from incoming to actual up to remainingExpected; extra becomes overage to resolve (accept or supplier return)
        const moveQty = Math.min(scannedQty, remainingExpected);
        const extraQty = Math.max(0, scannedQty - moveQty);

        // В факт кладём только то, что относится к закупке (moveQty). Излишек НЕ кладём автоматически.
        let newActual = actual + moveQty;
        let newIncoming = incoming - moveQty;
        if (newIncoming < 0) newIncoming = 0;

        const dwId = receiptWarehouseId;
        if (dwId && moveQty > 0) {
          await client.query(
            `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
             VALUES ($1, $2, GREATEST(0, COALESCE((SELECT quantity FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE), 0) + $3::int))
             ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = GREATEST(0, product_warehouse_stock.quantity + $3::int)`,
            [productId, dwId, moveQty]
          );
          await client.query(
            'UPDATE products SET incoming_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [newIncoming, productId]
          );
        } else if (!dwId) {
          await client.query(
            'UPDATE products SET quantity = $1, incoming_quantity = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [newActual, newIncoming, productId]
          );
        } else {
          await client.query(
            'UPDATE products SET incoming_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [newIncoming, productId]
          );
        }

        // update purchase item received
        const newReceived = received + moveQty;
        await client.query(
          'UPDATE purchase_items SET received_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE purchase_id = $2 AND product_id = $3',
          [newReceived, purchaseId, productId]
        );

        // movements: actual receipt (+moveQty) and incoming consumption (-moveQty)
        if (moveQty > 0) {
          const balRow = await client.query('SELECT quantity FROM products WHERE id = $1', [productId]);
          const balanceActual =
            balRow.rows?.[0]?.quantity != null ? Number(balRow.rows[0].quantity) : newActual;
          await client.query(
            `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta, warehouse_id)
             VALUES ($1, 'receipt', $2, $3, $4, $5, $6)`,
            [
              productId,
              moveQty,
              balanceActual,
              `Приёмка по закупке №${purchaseId}`,
              JSON.stringify({ purchase_id: purchaseId, purchase_receipt_id: rid }),
              dwId || null,
            ]
          );
        }
        if (moveQty > 0) {
          await client.query(
            `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta, warehouse_id)
             VALUES ($1, 'incoming', $2, $3, $4, $5, $6)`,
            [
              productId,
              -moveQty,
              newIncoming,
              `Списание incoming по приёмке №${rid}`,
              JSON.stringify({ purchase_id: purchaseId, purchase_receipt_id: rid }),
              dwId || null,
            ]
          );
        }

        deltas.push({
          productId,
          scannedQty,
          movedFromIncoming: moveQty,
          extraQty,
        });

        if (extraQty > 0) {
          const pinfo = await client.query('SELECT sku, name FROM products WHERE id = $1', [productId]);
          extras.push({
            productId,
            sku: pinfo.rows?.[0]?.sku ?? null,
            name: pinfo.rows?.[0]?.name ?? null,
            quantity: extraQty,
          });
        }
      }

      await client.query(`UPDATE purchases SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [purchaseId]);

      await client.query(
        `UPDATE purchase_receipts
         SET status = 'completed',
             completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP,
             extras_resolved = CASE WHEN $2::boolean THEN false ELSE extras_resolved END
         WHERE id = $1`,
        [rid, (extras.length > 0)]
      );

      // Складская приёмка (единая сущность для пользователя): создаём документ warehouse_receipts + строки,
      // но НЕ делаем движений остатков (они уже записаны выше в stock_movements).
      let warehouseReceiptId = null;
      try {
        const moved = deltas.filter((d) => (d?.movedFromIncoming ?? 0) > 0);
        if (moved.length > 0) {
          // если документ уже был создан на этапе createReceiptFromPurchase — используем его
          const wh = await client.query(
            `SELECT warehouse_receipt_id FROM purchase_receipts WHERE id = $1 FOR UPDATE`,
            [rid]
          );
          warehouseReceiptId = wh.rows?.[0]?.warehouse_receipt_id ?? null;

          if (!warehouseReceiptId) {
            const head = await client.query(
              `SELECT supplier_id, organization_id FROM purchases WHERE id = $1`,
              [purchaseId]
            );
            const supplierId = head.rows?.[0]?.supplier_id ?? null;
            const organizationId = head.rows?.[0]?.organization_id ?? null;
            const docIns = await client.query(
              `INSERT INTO warehouse_receipts (supplier_id, organization_id, document_type)
               VALUES ($1, $2, 'receipt')
               RETURNING id`,
              [supplierId, organizationId]
            );
            warehouseReceiptId = docIns.rows?.[0]?.id ?? null;
            if (warehouseReceiptId) {
              const receiptNumber = `ПТ-${String(warehouseReceiptId).padStart(6, '0')}`;
              await client.query(
                `UPDATE warehouse_receipts SET receipt_number = $1 WHERE id = $2`,
                [receiptNumber, warehouseReceiptId]
              );
              await client.query(
                `UPDATE purchase_receipts SET warehouse_receipt_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [rid, warehouseReceiptId]
              );
            }
          }

          if (warehouseReceiptId) {
            const hasPrice = await hasPurchasePriceColumn((sql) => client.query(sql));
            for (const d of moved) {
              const productId = Number(d.productId);
              const qty = Math.max(1, parseInt(d.movedFromIncoming, 10) || 0);
              if (!productId || qty <= 0) continue;
              let cost = null;
              if (hasPrice) {
                const prc = await client.query(
                  `SELECT purchase_price FROM purchase_items WHERE purchase_id = $1 AND product_id = $2`,
                  [purchaseId, productId]
                );
                if (prc.rows?.[0]?.purchase_price != null) {
                  const c = Number(prc.rows[0].purchase_price);
                  cost = Number.isFinite(c) && c >= 0 ? c : null;
                }
              }
              await client.query(
                `INSERT INTO warehouse_receipt_lines (receipt_id, product_id, quantity, cost)
                 VALUES ($1, $2, $3, $4)`,
                [warehouseReceiptId, productId, qty, cost]
              );
            }
          }
        }
      } catch {
        warehouseReceiptId = null;
      }

      // problems: products where actual + incoming < reserved
      const problems = await client.query(
        `SELECT id AS product_id, sku, name,
                COALESCE(quantity, 0) AS actual,
                COALESCE(incoming_quantity, 0) AS incoming,
                COALESCE(reserved_quantity, 0) AS reserved
         FROM products
         WHERE (COALESCE(quantity,0) + COALESCE(incoming_quantity,0)) < COALESCE(reserved_quantity,0)
         ORDER BY sku ASC
         LIMIT 200`
      );

      return {
        ok: true,
        purchaseId,
        purchaseStatus: 'open',
        receiptId: rid,
        warehouseReceiptId,
        applied: deltas,
        extras,
        stockProblems: problems.rows || [],
        warehouseId: receiptWarehouseId,
        completedAt: nowIso(),
      };
    });
  }

  /**
   * Удалить приёмку по закупке.
   * Завершённая (completed): откат движений по meta.purchase_receipt_id, корректировка received и статуса закупки.
   * Активное сканирование: удаление строк склада и документа приёмки.
   */
  async deleteReceipt(receiptId, { profileId } = {}) {
    const rid = parseInt(receiptId, 10);
    if (!rid || Number.isNaN(rid)) {
      const err = new Error('Некорректный ID приёмки');
      err.statusCode = 400;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }

    let purchaseIdOut = null;
    await transaction(async (client) => {
      const r = await client.query(
        `SELECT r.id, r.status, r.purchase_id, r.warehouse_receipt_id
         FROM purchase_receipts r
         JOIN purchases p ON p.id = r.purchase_id
         WHERE r.id = $1 AND p.profile_id = $2
         FOR UPDATE`,
        [rid, pid]
      );
      const row = r.rows?.[0];
      if (!row) {
        const err = new Error('Приёмка не найдена');
        err.statusCode = 404;
        throw err;
      }
      const purchaseId = Number(row.purchase_id);
      purchaseIdOut = purchaseId;
      const st = String(row.status || '');
      const whId = row.warehouse_receipt_id != null ? Number(row.warehouse_receipt_id) : null;

      if (st === 'completed') {
        await reverseCompletedPurchaseReceiptInTx(client, rid, purchaseId);
        await client.query(`DELETE FROM purchase_receipts WHERE id = $1`, [rid]);
        await maybeDeleteOrphanWarehouseReceiptInTx(client, whId);
        await recalcPurchaseStatusAfterReceiptChangeInTx(client, purchaseId);
      } else {
        await deleteScanningPurchaseReceiptInTx(client, rid);
      }
    });

    return { ok: true, purchaseId: purchaseIdOut };
  }

  /**
   * Удалить закупку со всеми приёмками: откаты остатков, снятие incoming, возврат связанных заказов из «В закупке» в «Новый».
   */
  async deletePurchase(purchaseId, { profileId } = {}) {
    const id = parseInt(purchaseId, 10);
    if (!id || Number.isNaN(id)) {
      const err = new Error('Некорректный ID закупки');
      err.statusCode = 400;
      throw err;
    }
    const prof = normalizeProfileId(profileId);
    if (prof == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }

    let sourceList = [];
    await transaction(async (client) => {
      await assertPurchaseInProfile(client, id, prof);
      const ph = await client.query('SELECT id FROM purchases WHERE id = $1 FOR UPDATE', [id]);
      if (!ph.rows?.[0]) {
        const err = new Error('Закупка не найдена');
        err.statusCode = 404;
        throw err;
      }

      const receipts = await client.query(
        `SELECT id, status FROM purchase_receipts WHERE purchase_id = $1 ORDER BY id ASC`,
        [id]
      );
      for (const rec of receipts.rows || []) {
        const rId = Number(rec.id);
        const rst = String(rec.status || '');
        if (rst === 'completed') {
          const whRow = await client.query(`SELECT warehouse_receipt_id FROM purchase_receipts WHERE id = $1 FOR UPDATE`, [rId]);
          const whId = whRow.rows?.[0]?.warehouse_receipt_id ?? null;
          await reverseCompletedPurchaseReceiptInTx(client, rId, id);
          await client.query(`DELETE FROM purchase_receipts WHERE id = $1`, [rId]);
          await maybeDeleteOrphanWarehouseReceiptInTx(client, whId);
        } else {
          await deleteScanningPurchaseReceiptInTx(client, rId);
        }
      }

      await removeRemainingIncomingForPurchaseInTx(client, id);

      sourceList = await collectAllSourceOrdersFromPurchaseInTx(client, id);
      await revertInProcurementOrdersFromSourceListInTx(client, sourceList, {
        profileId: prof,
        excludePurchaseId: id,
      });
      await client.query(`DELETE FROM purchases WHERE id = $1`, [id]);
    });

    const uniq = new Map();
    for (const o of sourceList || []) {
      const k = `${String(o.marketplace || '').toLowerCase()}|${String(o.orderId ?? '')}`;
      if (!k.endsWith('|')) uniq.set(k, o);
    }
    for (const o of uniq.values()) {
      await releaseReservesAfterRevertForSourceOrder(o.marketplace, o.orderId);
    }

    return { ok: true, releasedOrders: [...uniq.values()] };
  }

  /**
   * Разрулить излишки по приёмке: принять на склад (увеличить stock_actual) ИЛИ создать возврат поставщику.
   * action: 'accept' | 'return'
   */
  async resolveReceiptExtras(
    receiptId,
    { action, supplierId = null, note = null, warehouseId } = {},
    { profileId, userId } = {}
  ) {
    const rid = parseInt(receiptId, 10);
    if (!rid || Number.isNaN(rid)) {
      const err = new Error('Некорректный ID приёмки');
      err.statusCode = 400;
      throw err;
    }
    const pid = normalizeProfileId(profileId);
    if (pid == null) {
      const err = new Error('Профиль не определён');
      err.statusCode = 403;
      throw err;
    }
    const act = String(action || '').trim().toLowerCase();
    if (act !== 'accept' && act !== 'return') {
      const err = new Error("action должен быть 'accept' или 'return'");
      err.statusCode = 400;
      throw err;
    }
    const uid = userId != null ? parseInt(userId, 10) : null;
    const supplier = supplierId != null && supplierId !== '' ? Number(supplierId) : null;

    return transaction(async (client) => {
      const r = await client.query(
        `SELECT r.id, r.status, r.extras_resolved, r.purchase_id
         FROM purchase_receipts r
         JOIN purchases p ON p.id = r.purchase_id
         WHERE r.id = $1 AND p.profile_id = $2
         FOR UPDATE`,
        [rid, pid]
      );
      const receipt = r.rows?.[0];
      if (!receipt) {
        const err = new Error('Приёмка не найдена');
        err.statusCode = 404;
        throw err;
      }
      if (receipt.status !== 'completed') {
        const err = new Error('Излишки можно разрулить только после завершения приёмки');
        err.statusCode = 400;
        throw err;
      }
      if (receipt.extras_resolved) {
        const err = new Error('Излишки уже разрулены');
        err.statusCode = 400;
        throw err;
      }

      const purchaseId = Number(receipt.purchase_id);
      await assertPurchaseInProfile(client, purchaseId, pid);

      // recompute extras from receipt vs remainingExpected at current state
      const scanLines = await client.query(
        'SELECT product_id, scanned_quantity FROM purchase_receipt_items WHERE receipt_id = $1',
        [rid]
      );
      const extras = [];
      for (const row of scanLines.rows || []) {
        const productId = Number(row.product_id);
        const scannedQty = Math.max(0, parseInt(row.scanned_quantity, 10) || 0);
        if (!productId || scannedQty <= 0) continue;
        await assertProductAllowedInProfile(client, productId, pid);
        const pi = await client.query(
          'SELECT expected_quantity, received_quantity FROM purchase_items WHERE purchase_id = $1 AND product_id = $2',
          [purchaseId, productId]
        );
        const expected = pi.rows?.[0]?.expected_quantity != null ? Number(pi.rows[0].expected_quantity) : 0;
        const received = pi.rows?.[0]?.received_quantity != null ? Number(pi.rows[0].received_quantity) : 0;
        const remainingExpected = Math.max(0, expected - received);
        const moveQty = Math.min(scannedQty, remainingExpected);
        const extraQty = Math.max(0, scannedQty - moveQty);
        if (extraQty > 0) extras.push({ productId, quantity: extraQty });
      }
      if (extras.length === 0) {
        await client.query('UPDATE purchase_receipts SET extras_resolved = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [rid]);
        return { ok: true, action: act, extras: [], message: 'Излишков нет' };
      }

      if (act === 'accept') {
        const receiptWarehouseId = await resolveReceiptWarehouseIdForTx(client, warehouseId);
        for (const line of extras) {
          const pr = await client.query('SELECT quantity FROM products WHERE id = $1 FOR UPDATE', [line.productId]);
          if (!pr.rows?.[0]) continue;
          const d = Math.max(0, parseInt(line.quantity, 10) || 0);
          if (receiptWarehouseId && d > 0) {
            await client.query(
              `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
               VALUES ($1, $2, GREATEST(0, COALESCE((SELECT quantity FROM product_warehouse_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE), 0) + $3::int))
               ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = GREATEST(0, product_warehouse_stock.quantity + $3::int)`,
              [line.productId, receiptWarehouseId, d]
            );
          } else {
            await addToDefaultWarehouseStock(client, line.productId, d);
          }
          const na = await client.query('SELECT quantity FROM products WHERE id = $1', [line.productId]);
          const newActual = na.rows?.[0]?.quantity != null ? Number(na.rows[0].quantity) : 0;
          await client.query(
            `INSERT INTO stock_movements (product_id, type, quantity_change, balance_after, reason, meta, warehouse_id)
             VALUES ($1, 'receipt', $2, $3, $4, $5, $6)`,
            [
              line.productId,
              line.quantity,
              newActual,
              `Излишки по закупке №${purchaseId}`,
              JSON.stringify({ purchase_id: purchaseId, purchase_receipt_id: rid, extra: true }),
              receiptWarehouseId || null,
            ]
          );
        }
        await client.query('UPDATE purchase_receipts SET extras_resolved = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [rid]);
        return { ok: true, action: 'accept', extras };
      }

      // act === 'return' → создаём supplier_returns и строки, не меняя stock_actual (излишек не был принят)
      const ins = await client.query(
        `INSERT INTO supplier_returns (status, supplier_id, profile_id, created_by_user_id, purchase_id, purchase_receipt_id, note)
         VALUES ('draft', $1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [supplier, pid, uid && !Number.isNaN(uid) ? uid : null, purchaseId, rid, note || null]
      );
      const returnId = ins.rows[0].id;
      for (const line of extras) {
        await client.query(
          `INSERT INTO supplier_return_items (supplier_return_id, product_id, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (supplier_return_id, product_id)
           DO UPDATE SET quantity = EXCLUDED.quantity`,
          [returnId, line.productId, line.quantity]
        );
      }
      await client.query('UPDATE purchase_receipts SET extras_resolved = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [rid]);
      return { ok: true, action: 'return', supplierReturnId: returnId, extras };
    });
  }
}

export default new PurchasesService();

