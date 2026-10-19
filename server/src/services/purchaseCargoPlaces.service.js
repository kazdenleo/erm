/**
 * Грузоместа закупки.
 *
 * Поток: принять грузоместа сканом штрихкода поставщика/ТК → вскрыть место →
 * сканировать товар из него. Товар из места пишется и в purchase_cargo_place_items,
 * и в purchase_receipt_items черновика приёмки (status = 'scanning'), поэтому
 * оформление идёт обычной приёмкой по закупке (POST /purchases/receipts/:id/complete).
 */

import { query, transaction } from '../config/database.js';
import { looksLikeCis, productLookupCodesFromScan } from '../utils/chestnyZnak.js';
import addressStorageService from './addressStorage.service.js';
import chestnyZnakOps from './chestnyZnakOps.service.js';

const WAREHOUSE_LABEL_SQL = `NULLIF(TRIM(COALESCE(NULLIF(TRIM(w.name), ''), w.address, w.wb_warehouse_name, '')), '')`;
const MAX_BARCODE_LENGTH = 128;
const MAX_ADD_QUANTITY = 100000;

function httpError(statusCode, message, code = null, data = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  if (data) err.data = data;
  return err;
}

function requireProfileId(v) {
  const n = v == null || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n)) throw httpError(403, 'Профиль не определён');
  return n;
}

function requireId(v, message) {
  const n = parseInt(v, 10);
  if (!n || Number.isNaN(n) || n < 1) throw httpError(400, message);
  return n;
}

function optionalUserId(v) {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeBarcode(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim();
}

function placeState(row) {
  if (String(row.receipt_status || '') === 'completed') return 'received';
  return String(row.status);
}

function mapPlace(row) {
  return {
    id: Number(row.id),
    barcode: row.barcode,
    status: placeState(row),
    receiptId: row.receipt_id != null ? Number(row.receipt_id) : null,
    acceptedAt: row.accepted_at,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    itemsCount: Number(row.items_count) || 0,
    quantity: Number(row.quantity) || 0,
  };
}

function touchScanMeta(existing, userId) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const now = Date.now();
  const scannerId = 'cargo';
  const byScanner = base.byScanner && typeof base.byScanner === 'object' ? { ...base.byScanner } : {};
  byScanner[scannerId] = now;
  const byUser = base.byUser && typeof base.byUser === 'object' ? { ...base.byUser } : {};
  if (userId != null) byUser[String(userId)] = now;
  return { ...base, byScanner, byUser, lastScannerId: scannerId, lastScanAt: now };
}

/** Если черновик приёмки удалили (в вебе начали новую), товар из мест пропал вместе с ним — места снова «принято». */
async function resetPlacesWithLostReceiptInTx(client, purchaseId) {
  const lost = await client.query(
    `SELECT id FROM purchase_cargo_places
     WHERE purchase_id = $1 AND status IN ('opened', 'closed') AND receipt_id IS NULL
     FOR UPDATE`,
    [purchaseId]
  );
  const ids = (lost.rows || []).map((r) => Number(r.id));
  if (!ids.length) return;
  await client.query(`DELETE FROM purchase_cargo_place_items WHERE cargo_place_id = ANY($1::bigint[])`, [ids]);
  await client.query(
    `UPDATE purchase_cargo_places
     SET status = 'accepted', opened_at = NULL, opened_by_user_id = NULL,
         closed_at = NULL, closed_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1::bigint[])`,
    [ids]
  );
}

async function loadPurchaseInTx(client, purchaseId, profileId, { forUpdate = false } = {}) {
  const r = await client.query(
    `SELECT id, status FROM purchases WHERE id = $1 AND profile_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [purchaseId, profileId]
  );
  const row = r.rows?.[0];
  if (!row) throw httpError(404, 'Закупка не найдена');
  return row;
}

function assertPurchaseOpen(purchase) {
  if (String(purchase.status) === 'archived') {
    throw httpError(400, 'Закупка в архиве (всё принято)');
  }
}

async function lockPlaceInTx(client, placeId, profileId) {
  const r = await client.query(
    `SELECT cp.*, p.status AS purchase_status, r.status AS receipt_status
     FROM purchase_cargo_places cp
     JOIN purchases p ON p.id = cp.purchase_id
     LEFT JOIN purchase_receipts r ON r.id = cp.receipt_id
     WHERE cp.id = $1 AND p.profile_id = $2
     FOR UPDATE OF cp`,
    [placeId, profileId]
  );
  const row = r.rows?.[0];
  if (!row) throw httpError(404, 'Грузоместо не найдено');
  return row;
}

async function ensureScanningReceiptInTx(client, purchaseId, userId) {
  const existing = await client.query(
    `SELECT id FROM purchase_receipts
     WHERE purchase_id = $1 AND status = 'scanning'
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE`,
    [purchaseId]
  );
  if (existing.rows?.[0]?.id) return Number(existing.rows[0].id);
  const ins = await client.query(
    `INSERT INTO purchase_receipts (purchase_id, status, started_at, created_by_user_id)
     VALUES ($1, 'scanning', CURRENT_TIMESTAMP, $2)
     RETURNING id`,
    [purchaseId, userId]
  );
  return Number(ins.rows[0].id);
}

function assertPlaceEditable(place) {
  if (String(place.receipt_status || '') === 'completed') {
    throw httpError(400, 'Товар из этого грузоместа уже оприходован');
  }
  if (!['opened', 'closed'].includes(String(place.status)) || !place.receipt_id) {
    throw httpError(400, 'Сначала вскройте грузоместо');
  }
  if (String(place.receipt_status || '') !== 'scanning') {
    throw httpError(400, 'Приёмка по грузоместу недоступна для изменений');
  }
}

/** Прибавить delta к строке черновика приёмки (не ниже нуля). */
async function applyReceiptDeltaInTx(client, receiptId, productId, delta, userId) {
  const cur = await client.query(
    `SELECT id, scanned_quantity, scan_meta FROM purchase_receipt_items
     WHERE receipt_id = $1 AND product_id = $2
     FOR UPDATE`,
    [receiptId, productId]
  );
  const row = cur.rows?.[0];
  const prev = row ? Math.max(0, Number(row.scanned_quantity) || 0) : 0;
  const next = Math.max(0, prev + delta);
  const meta = JSON.stringify(touchScanMeta(row?.scan_meta, userId));
  if (row) {
    await client.query(
      `UPDATE purchase_receipt_items
       SET scanned_quantity = $2, scan_meta = $3::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [row.id, next, meta]
    );
  } else if (next > 0) {
    await client.query(
      `INSERT INTO purchase_receipt_items (receipt_id, product_id, scanned_quantity, scan_meta)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [receiptId, productId, next, meta]
    );
  }
}

/** Новое количество товара в грузоместе; возвращает разницу со старым. */
async function setPlaceItemQuantityInTx(client, placeId, productId, quantity) {
  const cur = await client.query(
    `SELECT quantity FROM purchase_cargo_place_items WHERE cargo_place_id = $1 AND product_id = $2 FOR UPDATE`,
    [placeId, productId]
  );
  const prev = Number(cur.rows?.[0]?.quantity) || 0;
  if (quantity <= 0) {
    await client.query(`DELETE FROM purchase_cargo_place_items WHERE cargo_place_id = $1 AND product_id = $2`, [
      placeId,
      productId,
    ]);
  } else {
    await client.query(
      `INSERT INTO purchase_cargo_place_items (cargo_place_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cargo_place_id, product_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
      [placeId, productId, quantity]
    );
  }
  return Math.max(0, quantity) - prev;
}

/** Товар по скану: штрихкод, GTIN из кода маркировки или артикул; товары закупки в приоритете. */
async function resolveProductIdInTx(client, code, profileId, purchaseId) {
  const codes = productLookupCodesFromScan(code);
  for (const c of codes.length ? codes : [code]) {
    const digits = String(c).replace(/\D+/g, '');
    const r = await client.query(
      `SELECT b.product_id
       FROM barcodes b
       JOIN products pr ON pr.id = b.product_id
       WHERE pr.profile_id = $3
         AND (TRIM(b.barcode) = TRIM($1) OR ($2 <> '' AND REGEXP_REPLACE(b.barcode, '\\D', '', 'g') = $2))
       ORDER BY EXISTS (
         SELECT 1 FROM purchase_items pi WHERE pi.purchase_id = $4 AND pi.product_id = b.product_id
       ) DESC
       LIMIT 1`,
      [c, digits, profileId, purchaseId]
    );
    if (r.rows?.[0]?.product_id) return Number(r.rows[0].product_id);
  }
  for (const c of codes.length ? codes : [code]) {
    const r = await client.query(`SELECT id FROM products WHERE sku = $1 AND profile_id = $2 LIMIT 1`, [c, profileId]);
    if (r.rows?.[0]?.id) return Number(r.rows[0].id);
  }
  return null;
}

class PurchaseCargoPlacesService {
  /** Открытые закупки с прогрессом по грузоместам. */
  async listPurchases({ profileId, search = '' } = {}) {
    const pid = requireProfileId(profileId);
    const params = [pid];
    let filter = '';
    const q = String(search || '').trim();
    if (q) {
      params.push(q.replace(/^[#№]/, ''), `%${q}%`);
      filter = ` AND (p.id::text = $2 OR s.name ILIKE $3)`;
    }
    const r = await query(
      `SELECT p.id, p.created_at, p.ordered_at, p.status, p.note, p.expected_cargo_places,
              p.supplier_id, s.name AS supplier_name,
              p.organization_id, o.name AS organization_name,
              p.warehouse_id, ${WAREHOUSE_LABEL_SQL} AS warehouse_name,
              COALESCE(items.cnt, 0)::int AS items_count,
              COALESCE(items.exp_sum, 0)::int AS expected_total,
              COALESCE(items.rec_sum, 0)::int AS received_total,
              COALESCE(cargo.total, 0)::int AS cargo_total,
              COALESCE(cargo.opened, 0)::int AS cargo_opened,
              COALESCE(cargo.done, 0)::int AS cargo_done
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN organizations o ON o.id = p.organization_id
       LEFT JOIN warehouses w ON w.id = p.warehouse_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt,
                SUM(expected_quantity) AS exp_sum,
                SUM(COALESCE(received_quantity, 0)) AS rec_sum
         FROM purchase_items WHERE purchase_id = p.id
       ) items ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE cp.status = 'opened' AND COALESCE(r.status, '') <> 'completed') AS opened,
                COUNT(*) FILTER (WHERE cp.status = 'closed' OR r.status = 'completed') AS done
         FROM purchase_cargo_places cp
         LEFT JOIN purchase_receipts r ON r.id = cp.receipt_id
         WHERE cp.purchase_id = p.id
       ) cargo ON TRUE
       WHERE p.profile_id = $1 AND p.status = 'open'${filter}
       ORDER BY COALESCE(cargo.total, 0) > COALESCE(cargo.done, 0) DESC, p.created_at DESC, p.id DESC
       LIMIT 200`,
      params
    );
    return (r.rows || []).map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at,
      orderedAt: row.ordered_at,
      note: row.note,
      supplierId: row.supplier_id != null ? Number(row.supplier_id) : null,
      supplierName: row.supplier_name,
      organizationName: row.organization_name,
      warehouseId: row.warehouse_id != null ? Number(row.warehouse_id) : null,
      warehouseName: row.warehouse_name,
      itemsCount: row.items_count,
      expectedTotal: row.expected_total,
      receivedTotal: row.received_total,
      expectedCargoPlaces: row.expected_cargo_places != null ? Number(row.expected_cargo_places) : null,
      cargoTotal: row.cargo_total,
      cargoOpened: row.cargo_opened,
      cargoDone: row.cargo_done,
    }));
  }

  /** Закупка: грузоместа, активный черновик приёмки и итоги. */
  async getPurchaseState(purchaseId, { profileId } = {}) {
    const pid = requireProfileId(profileId);
    const id = requireId(purchaseId, 'Некорректный ID закупки');
    return transaction(async (client) => {
      await loadPurchaseInTx(client, id, pid);
      await resetPlacesWithLostReceiptInTx(client, id);
      return this._stateInTx(client, id);
    });
  }

  async _stateInTx(client, purchaseId) {
    const head = await client.query(
      `SELECT p.id, p.profile_id, p.status, p.note, p.created_at, p.expected_cargo_places,
              p.supplier_id, s.name AS supplier_name,
              p.organization_id, o.name AS organization_name,
              p.warehouse_id, ${WAREHOUSE_LABEL_SQL} AS warehouse_name
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN organizations o ON o.id = p.organization_id
       LEFT JOIN warehouses w ON w.id = p.warehouse_id
       WHERE p.id = $1`,
      [purchaseId]
    );
    const p = head.rows[0];
    const places = await client.query(
      `SELECT cp.*, r.status AS receipt_status,
              COALESCE(it.cnt, 0)::int AS items_count,
              COALESCE(it.qty, 0)::int AS quantity
       FROM purchase_cargo_places cp
       LEFT JOIN purchase_receipts r ON r.id = cp.receipt_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt, SUM(quantity) AS qty
         FROM purchase_cargo_place_items WHERE cargo_place_id = cp.id
       ) it ON TRUE
       WHERE cp.purchase_id = $1
       ORDER BY cp.accepted_at ASC, cp.id ASC`,
      [purchaseId]
    );
    const receiptR = await client.query(
      `SELECT r.id, r.created_by_user_id,
              COALESCE((SELECT SUM(scanned_quantity) FROM purchase_receipt_items WHERE receipt_id = r.id), 0)::int AS scanned_total
       FROM purchase_receipts r
       WHERE r.purchase_id = $1 AND r.status = 'scanning'
       ORDER BY r.id DESC
       LIMIT 1`,
      [purchaseId]
    );
    const totals = await client.query(
      `SELECT COUNT(*)::int AS items_count,
              COALESCE(SUM(expected_quantity), 0)::int AS expected_total,
              COALESCE(SUM(COALESCE(received_quantity, 0)), 0)::int AS received_total
       FROM purchase_items WHERE purchase_id = $1`,
      [purchaseId]
    );
    const receipt = receiptR.rows?.[0];
    const reportR = await client.query(
      `SELECT cp.id AS place_id, cp.barcode,
              ci.product_id, ci.quantity, pr.sku, pr.name
       FROM purchase_cargo_places cp
       JOIN purchase_cargo_place_items ci ON ci.cargo_place_id = cp.id
       JOIN products pr ON pr.id = ci.product_id
       WHERE cp.purchase_id = $1
       ORDER BY cp.accepted_at ASC, cp.id ASC, pr.sku ASC`,
      [purchaseId]
    );
    const reportProductIds = [...new Set((reportR.rows || []).map((r) => Number(r.product_id)).filter(Boolean))];
    const storage = await addressStorageService.storageUiForProducts(reportProductIds, {
      profileId: p.profile_id != null ? Number(p.profile_id) : null,
      warehouseId: p.warehouse_id,
    });
    const reportPlaces = new Map();
    for (const row of reportR.rows || []) {
      const placeId = Number(row.place_id);
      if (!reportPlaces.has(placeId)) {
        reportPlaces.set(placeId, { placeId, barcode: row.barcode, items: [], quantity: 0 });
      }
      const place = reportPlaces.get(placeId);
      const qty = Number(row.quantity) || 0;
      const pid = Number(row.product_id);
      const loc = storage.locations[pid];
      place.items.push({
        productId: pid,
        sku: row.sku,
        article: row.sku || null,
        name: row.name,
        quantity: qty,
        locationCode: loc?.code || null,
        locationAssigned: loc?.assigned === true,
      });
      place.quantity += qty;
    }
    return {
      purchase: {
        id: Number(p.id),
        status: p.status,
        note: p.note,
        createdAt: p.created_at,
        supplierName: p.supplier_name,
        organizationName: p.organization_name,
        warehouseId: p.warehouse_id != null ? Number(p.warehouse_id) : null,
        warehouseName: p.warehouse_name,
        itemsCount: totals.rows[0].items_count,
        expectedTotal: totals.rows[0].expected_total,
        receivedTotal: totals.rows[0].received_total,
      },
      expectedCargoPlaces: p.expected_cargo_places != null ? Number(p.expected_cargo_places) : null,
      places: (places.rows || []).map(mapPlace),
      addressStorageEnabled: storage.addressStorageEnabled,
      report: {
        places: [...reportPlaces.values()],
        totalQuantity: [...reportPlaces.values()].reduce((s, pl) => s + pl.quantity, 0),
      },
      receipt: receipt
        ? {
            id: Number(receipt.id),
            createdByUserId: receipt.created_by_user_id != null ? Number(receipt.created_by_user_id) : null,
            scannedTotal: Number(receipt.scanned_total) || 0,
          }
        : null,
    };
  }

  async setExpectedCount(purchaseId, { expectedCargoPlaces } = {}, { profileId } = {}) {
    const pid = requireProfileId(profileId);
    const id = requireId(purchaseId, 'Некорректный ID закупки');
    let value = null;
    if (expectedCargoPlaces != null && expectedCargoPlaces !== '') {
      value = Math.floor(Number(expectedCargoPlaces));
      if (!Number.isFinite(value) || value < 0 || value > 10000) {
        throw httpError(400, 'Некорректное количество грузомест');
      }
    }
    return transaction(async (client) => {
      await loadPurchaseInTx(client, id, pid, { forUpdate: true });
      await client.query(
        `UPDATE purchases SET expected_cargo_places = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id, value]
      );
      return this._stateInTx(client, id);
    });
  }

  /** Принять грузоместо по штрихкоду. Повторный скан того же места — не ошибка. */
  async acceptPlace(purchaseId, { barcode, force = false } = {}, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const id = requireId(purchaseId, 'Некорректный ID закупки');
    const code = normalizeBarcode(barcode);
    if (!code) throw httpError(400, 'Пустой штрихкод грузоместа');
    if (code.length > MAX_BARCODE_LENGTH) throw httpError(400, 'Слишком длинный штрихкод грузоместа');
    const uid = optionalUserId(userId);

    return transaction(async (client) => {
      const purchase = await loadPurchaseInTx(client, id, pid, { forUpdate: true });
      assertPurchaseOpen(purchase);

      const same = await client.query(
        `SELECT id FROM purchase_cargo_places WHERE purchase_id = $1 AND barcode = $2`,
        [id, code]
      );
      if (same.rows?.[0]) {
        return { placeId: Number(same.rows[0].id), alreadyAccepted: true, state: await this._stateInTx(client, id) };
      }

      const other = await client.query(
        `SELECT cp.purchase_id
         FROM purchase_cargo_places cp
         JOIN purchases p ON p.id = cp.purchase_id
         WHERE cp.barcode = $1 AND p.profile_id = $2 AND p.status = 'open'
         LIMIT 1`,
        [code, pid]
      );
      if (other.rows?.[0]) {
        throw httpError(409, `Это грузоместо уже принято по закупке №${other.rows[0].purchase_id}`, 'CARGO_IN_OTHER_PURCHASE');
      }

      if (!force) {
        const productId = await resolveProductIdInTx(client, code, pid, id);
        if (productId) {
          const pr = await client.query(`SELECT name, sku FROM products WHERE id = $1`, [productId]);
          const name = pr.rows?.[0]?.name || pr.rows?.[0]?.sku || `#${productId}`;
          throw httpError(409, `Это штрихкод товара «${name}», а не грузоместа`, 'PRODUCT_BARCODE', { productId });
        }
      }

      const ins = await client.query(
        `INSERT INTO purchase_cargo_places (purchase_id, barcode, accepted_by_user_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [id, code, uid]
      );
      return { placeId: Number(ins.rows[0].id), alreadyAccepted: false, state: await this._stateInTx(client, id) };
    });
  }

  async removePlace(placeId, { profileId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    return transaction(async (client) => {
      const place = await lockPlaceInTx(client, cid, pid);
      const items = await client.query(
        `SELECT 1 FROM purchase_cargo_place_items WHERE cargo_place_id = $1 LIMIT 1`,
        [cid]
      );
      if (items.rows?.length) {
        throw httpError(400, 'В грузоместе уже есть принятый товар — сначала уберите его');
      }
      await client.query(`DELETE FROM purchase_cargo_places WHERE id = $1`, [cid]);
      return this._stateInTx(client, Number(place.purchase_id));
    });
  }

  /** Вскрыть грузоместо: привязать к черновику приёмки (создаётся при необходимости). */
  async openPlace(placeId, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    const uid = optionalUserId(userId);
    await transaction(async (client) => {
      const place = await lockPlaceInTx(client, cid, pid);
      const purchaseId = Number(place.purchase_id);
      if (String(place.receipt_status || '') === 'completed') {
        throw httpError(400, 'Товар из этого грузоместа уже оприходован');
      }
      if (place.status === 'opened' && place.receipt_status === 'scanning') return;
      if (place.status === 'closed' && place.receipt_status === 'scanning') {
        await client.query(
          `UPDATE purchase_cargo_places
           SET status = 'opened', closed_at = NULL, closed_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [cid]
        );
        return;
      }
      const purchase = await loadPurchaseInTx(client, purchaseId, pid, { forUpdate: true });
      assertPurchaseOpen(purchase);
      await client.query(`DELETE FROM purchase_cargo_place_items WHERE cargo_place_id = $1`, [cid]);
      const receiptId = await ensureScanningReceiptInTx(client, purchaseId, uid);
      await client.query(
        `UPDATE purchase_cargo_places
         SET status = 'opened', receipt_id = $2, opened_at = CURRENT_TIMESTAMP, opened_by_user_id = $3,
             closed_at = NULL, closed_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [cid, receiptId, uid]
      );
    });
    return this.getPlace(cid, { profileId: pid });
  }

  async closePlace(placeId, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    const uid = optionalUserId(userId);
    await transaction(async (client) => {
      const place = await lockPlaceInTx(client, cid, pid);
      assertPlaceEditable(place);
      await client.query(
        `UPDATE purchase_cargo_places
         SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by_user_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [cid, uid]
      );
    });
    return this.getPlace(cid, { profileId: pid });
  }

  /** Грузоместо с товаром и сравнением с закупкой. */
  async getPlace(placeId, { profileId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    return transaction(async (client) => {
      const head = await client.query(
        `SELECT cp.purchase_id FROM purchase_cargo_places cp
         JOIN purchases p ON p.id = cp.purchase_id
         WHERE cp.id = $1 AND p.profile_id = $2`,
        [cid, pid]
      );
      if (!head.rows?.[0]) throw httpError(404, 'Грузоместо не найдено');
      const purchaseId = Number(head.rows[0].purchase_id);
      await resetPlacesWithLostReceiptInTx(client, purchaseId);

      const placeR = await client.query(
        `SELECT cp.*, r.status AS receipt_status, p.warehouse_id,
                COALESCE(it.cnt, 0)::int AS items_count,
                COALESCE(it.qty, 0)::int AS quantity,
                (SELECT COUNT(*) FROM purchase_cargo_places WHERE purchase_id = cp.purchase_id)::int AS places_total,
                (SELECT COUNT(*) FROM purchase_cargo_places x
                 WHERE x.purchase_id = cp.purchase_id
                   AND (x.accepted_at, x.id) <= (cp.accepted_at, cp.id))::int AS place_number
         FROM purchase_cargo_places cp
         JOIN purchases p ON p.id = cp.purchase_id
         LEFT JOIN purchase_receipts r ON r.id = cp.receipt_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS cnt, SUM(quantity) AS qty
           FROM purchase_cargo_place_items WHERE cargo_place_id = cp.id
         ) it ON TRUE
         WHERE cp.id = $1`,
        [cid]
      );
      const row = placeR.rows[0];
      const items = await client.query(
        `SELECT ci.product_id, ci.quantity, pr.sku, pr.name,
                pi.expected_quantity, pi.received_quantity,
                COALESCE(ri.scanned_quantity, 0)::int AS receipt_quantity
         FROM purchase_cargo_place_items ci
         JOIN products pr ON pr.id = ci.product_id
         LEFT JOIN purchase_items pi ON pi.purchase_id = $2 AND pi.product_id = ci.product_id
         LEFT JOIN purchase_receipt_items ri ON ri.receipt_id = $3 AND ri.product_id = ci.product_id
         WHERE ci.cargo_place_id = $1
         ORDER BY ci.updated_at DESC, pr.sku ASC`,
        [cid, purchaseId, row.receipt_id]
      );
      const mappedItems = (items.rows || []).map((it) => ({
        productId: Number(it.product_id),
        sku: it.sku || null,
        article: it.sku || null,
        name: it.name,
        quantity: Number(it.quantity) || 0,
        inPurchase: it.expected_quantity != null,
        expectedQuantity: it.expected_quantity != null ? Number(it.expected_quantity) : null,
        receivedBefore: Number(it.received_quantity) || 0,
        receiptQuantity: Number(it.receipt_quantity) || 0,
      }));
      const storage = await addressStorageService.storageUiForProducts(
        mappedItems.map((i) => i.productId),
        { profileId: pid, warehouseId: row.warehouse_id }
      );
      for (const item of mappedItems) {
        const loc = storage.locations[item.productId];
        item.locationCode = loc?.code || null;
        item.locationAssigned = loc?.assigned === true;
      }
      return {
        place: {
          ...mapPlace(row),
          number: Number(row.place_number) || null,
          placesTotal: Number(row.places_total) || 0,
        },
        purchaseId,
        warehouseId: row.warehouse_id != null ? Number(row.warehouse_id) : null,
        addressStorageEnabled: storage.addressStorageEnabled,
        items: mappedItems,
      };
    });
  }

  /** Товар из грузоместа: + quantity (по скану или productId). */
  async addItem(placeId, { code = null, productId = null, quantity = 1 } = {}, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    const uid = optionalUserId(userId);
    const qty = Math.floor(Number(quantity) || 0);
    if (qty <= 0 || qty > MAX_ADD_QUANTITY) throw httpError(400, 'Количество должно быть больше 0');
    const scan = normalizeBarcode(code);
    const directProductId = productId != null && productId !== '' ? requireId(productId, 'Некорректный товар') : null;
    if (!scan && !directProductId) throw httpError(400, 'Отсканируйте товар');

    if (scan && !directProductId && looksLikeCis(scan)) {
      if (qty !== 1) throw httpError(400, 'Код маркировки сканируется поштучно');
      const cis = await this._bindCis(scan, cid, pid);
      if (cis?.duplicate) throw httpError(409, 'Этот код маркировки уже отсканирован', 'CIS_DUPLICATE');
    }

    const result = await transaction(async (client) => {
      const place = await lockPlaceInTx(client, cid, pid);
      const purchaseId = Number(place.purchase_id);

      if (scan && !directProductId) {
        const otherPlace = await client.query(
          `SELECT id FROM purchase_cargo_places WHERE purchase_id = $1 AND barcode = $2`,
          [purchaseId, scan]
        );
        if (otherPlace.rows?.[0]) {
          const otherId = Number(otherPlace.rows[0].id);
          throw httpError(
            409,
            otherId === cid ? 'Это штрихкод текущего грузоместа' : 'Это штрихкод другого грузоместа',
            'CARGO_PLACE_BARCODE',
            { placeId: otherId }
          );
        }
      }

      assertPlaceEditable(place);

      let resolvedProductId = directProductId;
      if (!resolvedProductId) {
        resolvedProductId = await resolveProductIdInTx(client, scan, pid, purchaseId);
        if (!resolvedProductId) {
          throw httpError(404, looksLikeCis(scan) ? 'Товар не найден по GTIN из кода маркировки' : 'Товар не найден по скану', 'PRODUCT_NOT_FOUND');
        }
      } else {
        const own = await client.query(`SELECT 1 FROM products WHERE id = $1 AND profile_id = $2`, [resolvedProductId, pid]);
        if (!own.rows?.length) throw httpError(403, 'Товар недоступен в вашем аккаунте');
      }

      const cur = await client.query(
        `SELECT quantity FROM purchase_cargo_place_items WHERE cargo_place_id = $1 AND product_id = $2`,
        [cid, resolvedProductId]
      );
      const nextQty = (Number(cur.rows?.[0]?.quantity) || 0) + qty;
      const delta = await setPlaceItemQuantityInTx(client, cid, resolvedProductId, nextQty);
      await applyReceiptDeltaInTx(client, Number(place.receipt_id), resolvedProductId, delta, uid);
      if (place.status === 'closed') {
        await client.query(
          `UPDATE purchase_cargo_places
           SET status = 'opened', closed_at = NULL, closed_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [cid]
        );
      }
      const pr = await client.query(
        `SELECT pr.name, pr.sku, pi.expected_quantity
         FROM products pr
         LEFT JOIN purchase_items pi ON pi.purchase_id = $2 AND pi.product_id = pr.id
         WHERE pr.id = $1`,
        [resolvedProductId, purchaseId]
      );
      return {
        receiptId: Number(place.receipt_id),
        purchaseId,
        product: {
          id: resolvedProductId,
          name: pr.rows?.[0]?.name,
          sku: pr.rows?.[0]?.sku,
          inPurchase: pr.rows?.[0]?.expected_quantity != null,
        },
        added: qty,
      };
    });

    return { ...result, ...(await this.getPlace(cid, { profileId: pid })) };
  }

  async _bindCis(code, placeId, profileId) {
    const head = await query(
      `SELECT cp.receipt_id, cp.purchase_id, p.organization_id, p.warehouse_id
       FROM purchase_cargo_places cp
       JOIN purchases p ON p.id = cp.purchase_id
       WHERE cp.id = $1 AND p.profile_id = $2`,
      [placeId, profileId]
    );
    const row = head.rows?.[0];
    if (!row?.receipt_id) return null;
    const productId = await resolveProductIdInTx({ query }, code, profileId, Number(row.purchase_id));
    if (!productId) return null;
    return chestnyZnakOps.tryBindCis({
      code,
      kind: 'purchase_accept',
      sourceType: 'purchase_receipt',
      sourceId: Number(row.receipt_id),
      productId,
      warehouseId: row.warehouse_id ?? null,
      profileId,
      organizationId: row.organization_id ?? null,
    });
  }

  /** Точное количество товара в грузоместе (0 — убрать позицию). */
  async setItemQuantity(placeId, { productId, quantity } = {}, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    const productIdNum = requireId(productId, 'Укажите товар');
    const qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty) || qty < 0 || qty > MAX_ADD_QUANTITY) throw httpError(400, 'Некорректное количество');
    const uid = optionalUserId(userId);

    await transaction(async (client) => {
      const place = await lockPlaceInTx(client, cid, pid);
      assertPlaceEditable(place);
      const delta = await setPlaceItemQuantityInTx(client, cid, productIdNum, qty);
      if (delta !== 0) await applyReceiptDeltaInTx(client, Number(place.receipt_id), productIdNum, delta, uid);
    });
    return this.getPlace(cid, { profileId: pid });
  }
}

export default new PurchaseCargoPlacesService();
