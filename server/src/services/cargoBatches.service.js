/**
 * Приёмка грузомест без закупки.
 *
 * Поток: создать пакет (склад) → принять места сканом → войти в место →
 * сканировать товар → оформить приёмку (warehouse_receipt). Разбивка
 * «товар × грузоместо» остаётся в БД и доступна в отчёте пакета.
 */

import { query, transaction } from '../config/database.js';
import { looksLikeCis, productLookupCodesFromScan } from '../utils/chestnyZnak.js';
import warehouseReceiptsService from './warehouseReceipts.service.js';

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

function mapPlace(row) {
  const batchStatus = String(row.batch_status || '');
  let status = String(row.status);
  if (batchStatus === 'completed') status = 'received';
  return {
    id: Number(row.id),
    barcode: row.barcode,
    status,
    acceptedAt: row.accepted_at,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    itemsCount: Number(row.items_count) || 0,
    quantity: Number(row.quantity) || 0,
  };
}

async function lockBatchInTx(client, batchId, profileId, { forUpdate = true } = {}) {
  const r = await client.query(
    `SELECT b.*, ${WAREHOUSE_LABEL_SQL} AS warehouse_name, s.name AS supplier_name
     FROM cargo_batches b
     LEFT JOIN warehouses w ON w.id = b.warehouse_id
     LEFT JOIN suppliers s ON s.id = b.supplier_id
     WHERE b.id = $1 AND b.profile_id = $2
     ${forUpdate ? 'FOR UPDATE OF b' : ''}`,
    [batchId, profileId]
  );
  const row = r.rows?.[0];
  if (!row) throw httpError(404, 'Пакет приёмки не найден');
  return row;
}

async function lockPlaceInTx(client, placeId, profileId) {
  const r = await client.query(
    `SELECT cp.*, b.status AS batch_status, b.profile_id, b.warehouse_id, b.organization_id
     FROM cargo_places cp
     JOIN cargo_batches b ON b.id = cp.batch_id
     WHERE cp.id = $1 AND b.profile_id = $2
     FOR UPDATE OF cp`,
    [placeId, profileId]
  );
  const row = r.rows?.[0];
  if (!row) throw httpError(404, 'Грузоместо не найдено');
  return row;
}

function assertBatchOpen(batch) {
  if (String(batch.status) !== 'open') throw httpError(400, 'Пакет уже оформлен или отменён');
}

function assertPlaceEditable(place) {
  if (String(place.batch_status) !== 'open') throw httpError(400, 'Пакет уже оформлен — менять нельзя');
  if (!['opened', 'closed'].includes(String(place.status))) {
    throw httpError(400, 'Сначала откройте грузоместо');
  }
}

async function resolveProductIdInTx(client, code, profileId) {
  const codes = productLookupCodesFromScan(code);
  for (const c of codes.length ? codes : [code]) {
    const digits = String(c).replace(/\D+/g, '');
    const r = await client.query(
      `SELECT b.product_id
       FROM barcodes b
       JOIN products pr ON pr.id = b.product_id
       WHERE pr.profile_id = $3
         AND (TRIM(b.barcode) = TRIM($1) OR ($2 <> '' AND REGEXP_REPLACE(b.barcode, '\\D', '', 'g') = $2))
       LIMIT 1`,
      [c, digits, profileId]
    );
    if (r.rows?.[0]?.product_id) return Number(r.rows[0].product_id);
  }
  for (const c of codes.length ? codes : [code]) {
    const r = await client.query(`SELECT id FROM products WHERE sku = $1 AND profile_id = $2 LIMIT 1`, [c, profileId]);
    if (r.rows?.[0]?.id) return Number(r.rows[0].id);
  }
  return null;
}

async function setPlaceItemQuantityInTx(client, placeId, productId, quantity) {
  const cur = await client.query(
    `SELECT quantity FROM cargo_place_items WHERE cargo_place_id = $1 AND product_id = $2 FOR UPDATE`,
    [placeId, productId]
  );
  const prev = Number(cur.rows?.[0]?.quantity) || 0;
  if (quantity <= 0) {
    await client.query(`DELETE FROM cargo_place_items WHERE cargo_place_id = $1 AND product_id = $2`, [
      placeId,
      productId,
    ]);
  } else {
    await client.query(
      `INSERT INTO cargo_place_items (cargo_place_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cargo_place_id, product_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
      [placeId, productId, quantity]
    );
  }
  return Math.max(0, quantity) - prev;
}

async function loadPlaces(client, batchId) {
  const r = await client.query(
    `SELECT cp.*, b.status AS batch_status,
            COALESCE(it.cnt, 0)::int AS items_count,
            COALESCE(it.qty, 0)::int AS quantity
     FROM cargo_places cp
     JOIN cargo_batches b ON b.id = cp.batch_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS cnt, SUM(quantity) AS qty
       FROM cargo_place_items WHERE cargo_place_id = cp.id
     ) it ON TRUE
     WHERE cp.batch_id = $1
     ORDER BY cp.accepted_at ASC, cp.id ASC`,
    [batchId]
  );
  return (r.rows || []).map(mapPlace);
}

async function loadReport(client, batchId) {
  const r = await client.query(
    `SELECT cp.id AS place_id, cp.barcode,
            ci.product_id, ci.quantity, pr.sku, pr.name
     FROM cargo_places cp
     JOIN cargo_place_items ci ON ci.cargo_place_id = cp.id
     JOIN products pr ON pr.id = ci.product_id
     WHERE cp.batch_id = $1
     ORDER BY cp.accepted_at ASC, cp.id ASC, pr.sku ASC`,
    [batchId]
  );
  const byPlace = new Map();
  const byProduct = new Map();
  for (const row of r.rows || []) {
    const placeId = Number(row.place_id);
    if (!byPlace.has(placeId)) {
      byPlace.set(placeId, { placeId, barcode: row.barcode, items: [], quantity: 0 });
    }
    const place = byPlace.get(placeId);
    const qty = Number(row.quantity) || 0;
    place.items.push({
      productId: Number(row.product_id),
      sku: row.sku,
      name: row.name,
      quantity: qty,
    });
    place.quantity += qty;

    const pid = Number(row.product_id);
    if (!byProduct.has(pid)) {
      byProduct.set(pid, {
        productId: pid,
        sku: row.sku,
        name: row.name,
        quantity: 0,
        places: [],
      });
    }
    const prod = byProduct.get(pid);
    prod.quantity += qty;
    prod.places.push({ placeId, barcode: row.barcode, quantity: qty });
  }
  return {
    places: [...byPlace.values()],
    products: [...byProduct.values()],
    totalQuantity: [...byProduct.values()].reduce((s, p) => s + p.quantity, 0),
  };
}

function mapBatch(row, places = [], report = null) {
  return {
    id: Number(row.id),
    status: row.status,
    expectedPlaces: row.expected_places != null ? Number(row.expected_places) : null,
    warehouseId: Number(row.warehouse_id),
    warehouseName: row.warehouse_name || null,
    organizationId: row.organization_id != null ? Number(row.organization_id) : null,
    supplierId: row.supplier_id != null ? Number(row.supplier_id) : null,
    supplierName: row.supplier_name || null,
    warehouseReceiptId: row.warehouse_receipt_id != null ? Number(row.warehouse_receipt_id) : null,
    note: row.note || null,
    createdByUserId: row.created_by_user_id != null ? Number(row.created_by_user_id) : null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    places,
    placesCount: places.length,
    placesDone: places.filter((p) => p.status === 'closed' || p.status === 'received').length,
    scannedTotal: places.reduce((s, p) => s + (Number(p.quantity) || 0), 0),
    report,
  };
}

class CargoBatchesService {
  async listBatches({ profileId, status = 'open' } = {}) {
    const pid = requireProfileId(profileId);
    const st = String(status || 'open').trim().toLowerCase();
    const params = [pid];
    let filter = '';
    if (st && st !== 'all') {
      params.push(st);
      filter = ` AND b.status = $2`;
    }
    const r = await query(
      `SELECT b.*, ${WAREHOUSE_LABEL_SQL} AS warehouse_name, s.name AS supplier_name,
              COALESCE(cargo.total, 0)::int AS places_count,
              COALESCE(cargo.done, 0)::int AS places_done,
              COALESCE(cargo.qty, 0)::int AS scanned_total
       FROM cargo_batches b
       LEFT JOIN warehouses w ON w.id = b.warehouse_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE cp.status = 'closed') AS done,
                COALESCE(SUM(it.qty), 0) AS qty
         FROM cargo_places cp
         LEFT JOIN LATERAL (
           SELECT SUM(quantity) AS qty FROM cargo_place_items WHERE cargo_place_id = cp.id
         ) it ON TRUE
         WHERE cp.batch_id = b.id
       ) cargo ON TRUE
       WHERE b.profile_id = $1${filter}
       ORDER BY b.status = 'open' DESC, b.updated_at DESC, b.id DESC
       LIMIT 100`,
      params
    );
    return (r.rows || []).map((row) => ({
      id: Number(row.id),
      status: row.status,
      expectedPlaces: row.expected_places != null ? Number(row.expected_places) : null,
      warehouseId: Number(row.warehouse_id),
      warehouseName: row.warehouse_name || null,
      supplierName: row.supplier_name || null,
      warehouseReceiptId: row.warehouse_receipt_id != null ? Number(row.warehouse_receipt_id) : null,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      placesCount: Number(row.places_count) || 0,
      placesDone: Number(row.places_done) || 0,
      scannedTotal: Number(row.scanned_total) || 0,
    }));
  }

  async createBatch({ warehouseId, organizationId = null, expectedPlaces = null, note = null } = {}, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const wid = requireId(warehouseId, 'Укажите склад');
    const uid = optionalUserId(userId);
    const orgId = organizationId != null && organizationId !== '' ? Number(organizationId) : null;
    let expected = expectedPlaces;
    if (expected != null && expected !== '') {
      expected = Math.floor(Number(expected));
      if (!Number.isFinite(expected) || expected < 0) throw httpError(400, 'Некорректное ожидаемое число мест');
    } else expected = null;

    const wh = await query(
      `SELECT id, organization_id FROM warehouses WHERE id = $1 AND profile_id = $2`,
      [wid, pid]
    );
    if (!wh.rows?.[0]) throw httpError(404, 'Склад не найден');
    const resolvedOrg = orgId || (wh.rows[0].organization_id != null ? Number(wh.rows[0].organization_id) : null);

    const ins = await query(
      `INSERT INTO cargo_batches
         (profile_id, organization_id, warehouse_id, expected_places, note, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [pid, resolvedOrg, wid, expected, note != null ? String(note).slice(0, 500) : null, uid]
    );
    return this.getBatch(Number(ins.rows[0].id), { profileId: pid });
  }

  async getBatch(batchId, { profileId } = {}) {
    const pid = requireProfileId(profileId);
    const id = requireId(batchId, 'Некорректный ID пакета');
    return transaction(async (client) => {
      const batch = await lockBatchInTx(client, id, pid, { forUpdate: false });
      const places = await loadPlaces(client, id);
      const report = await loadReport(client, id);
      return mapBatch(batch, places, report);
    });
  }

  async setExpected(batchId, { expectedPlaces } = {}, { profileId } = {}) {
    const pid = requireProfileId(profileId);
    const id = requireId(batchId, 'Некорректный ID пакета');
    let expected = expectedPlaces;
    if (expected != null && expected !== '') {
      expected = Math.floor(Number(expected));
      if (!Number.isFinite(expected) || expected < 0) throw httpError(400, 'Некорректное ожидаемое число мест');
    } else expected = null;
    await transaction(async (client) => {
      const batch = await lockBatchInTx(client, id, pid);
      assertBatchOpen(batch);
      await client.query(
        `UPDATE cargo_batches SET expected_places = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id, expected]
      );
    });
    return this.getBatch(id, { profileId: pid });
  }

  async acceptPlace(batchId, { barcode, force = false } = {}, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const id = requireId(batchId, 'Некорректный ID пакета');
    const uid = optionalUserId(userId);
    const code = normalizeBarcode(barcode);
    if (!code || code.length < 2 || code.length > MAX_BARCODE_LENGTH) {
      throw httpError(400, 'Отсканируйте штрихкод грузоместа');
    }

    if (!force) {
      const productHit = await query(
        `SELECT 1
         FROM barcodes b
         JOIN products pr ON pr.id = b.product_id
         WHERE pr.profile_id = $2
           AND (TRIM(b.barcode) = TRIM($1) OR REGEXP_REPLACE(b.barcode, '\\D', '', 'g') = REGEXP_REPLACE($1, '\\D', '', 'g'))
         LIMIT 1`,
        [code, pid]
      );
      if (productHit.rows?.length) {
        throw httpError(409, 'Похоже на штрихкод товара, а не грузоместа', 'PRODUCT_BARCODE');
      }
    }

    return transaction(async (client) => {
      const batch = await lockBatchInTx(client, id, pid);
      assertBatchOpen(batch);
      const existing = await client.query(
        `SELECT id FROM cargo_places WHERE batch_id = $1 AND barcode = $2`,
        [id, code]
      );
      if (existing.rows?.[0]) {
        const places = await loadPlaces(client, id);
        const report = await loadReport(client, id);
        return {
          alreadyAccepted: true,
          placeId: Number(existing.rows[0].id),
          state: mapBatch(batch, places, report),
        };
      }
      const otherBatch = await client.query(
        `SELECT cp.id, cp.batch_id
         FROM cargo_places cp
         JOIN cargo_batches b ON b.id = cp.batch_id
         WHERE b.profile_id = $1 AND b.status = 'open' AND cp.barcode = $2
         LIMIT 1`,
        [pid, code]
      );
      if (otherBatch.rows?.[0]) {
        throw httpError(409, 'Это грузоместо уже принято в другом открытом пакете', 'CARGO_IN_OTHER_BATCH', {
          batchId: Number(otherBatch.rows[0].batch_id),
          placeId: Number(otherBatch.rows[0].id),
        });
      }
      const ins = await client.query(
        `INSERT INTO cargo_places (batch_id, barcode, accepted_by_user_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [id, code, uid]
      );
      await client.query(`UPDATE cargo_batches SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
      const places = await loadPlaces(client, id);
      const report = await loadReport(client, id);
      return {
        alreadyAccepted: false,
        placeId: Number(ins.rows[0].id),
        state: mapBatch(batch, places, report),
      };
    });
  }

  async removePlace(placeId, { profileId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    let batchId = null;
    await transaction(async (client) => {
      const place = await lockPlaceInTx(client, cid, pid);
      assertBatchOpen(place);
      if (String(place.status) !== 'accepted') {
        throw httpError(400, 'Удалить можно только место без принятого товара');
      }
      batchId = Number(place.batch_id);
      await client.query(`DELETE FROM cargo_places WHERE id = $1`, [cid]);
      await client.query(`UPDATE cargo_batches SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [batchId]);
    });
    return this.getBatch(batchId, { profileId: pid });
  }

  async openPlace(placeId, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    const uid = optionalUserId(userId);
    await transaction(async (client) => {
      const place = await lockPlaceInTx(client, cid, pid);
      assertBatchOpen(place);
      if (place.status === 'opened') return;
      if (place.status === 'closed') {
        await client.query(
          `UPDATE cargo_places
           SET status = 'opened', closed_at = NULL, closed_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [cid]
        );
        return;
      }
      await client.query(
        `UPDATE cargo_places
         SET status = 'opened', opened_at = CURRENT_TIMESTAMP, opened_by_user_id = $2,
             closed_at = NULL, closed_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [cid, uid]
      );
      await client.query(`UPDATE cargo_batches SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [
        place.batch_id,
      ]);
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
        `UPDATE cargo_places
         SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by_user_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [cid, uid]
      );
    });
    return this.getPlace(cid, { profileId: pid });
  }

  async getPlace(placeId, { profileId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    return transaction(async (client) => {
      const placeR = await client.query(
        `SELECT cp.*, b.status AS batch_status, b.id AS batch_id,
                COALESCE(it.cnt, 0)::int AS items_count,
                COALESCE(it.qty, 0)::int AS quantity,
                (SELECT COUNT(*) FROM cargo_places WHERE batch_id = cp.batch_id)::int AS places_total,
                (SELECT COUNT(*) FROM cargo_places x
                 WHERE x.batch_id = cp.batch_id
                   AND (x.accepted_at, x.id) <= (cp.accepted_at, cp.id))::int AS place_number
         FROM cargo_places cp
         JOIN cargo_batches b ON b.id = cp.batch_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS cnt, SUM(quantity) AS qty
           FROM cargo_place_items WHERE cargo_place_id = cp.id
         ) it ON TRUE
         WHERE cp.id = $1 AND b.profile_id = $2`,
        [cid, pid]
      );
      const row = placeR.rows?.[0];
      if (!row) throw httpError(404, 'Грузоместо не найдено');
      const items = await client.query(
        `SELECT ci.product_id, ci.quantity, pr.sku, pr.name
         FROM cargo_place_items ci
         JOIN products pr ON pr.id = ci.product_id
         WHERE ci.cargo_place_id = $1
         ORDER BY ci.updated_at DESC, pr.sku ASC`,
        [cid]
      );
      return {
        place: {
          ...mapPlace(row),
          number: Number(row.place_number) || null,
          placesTotal: Number(row.places_total) || 0,
        },
        batchId: Number(row.batch_id),
        items: (items.rows || []).map((it) => ({
          productId: Number(it.product_id),
          sku: it.sku,
          name: it.name,
          quantity: Number(it.quantity) || 0,
        })),
      };
    });
  }

  async addItem(placeId, { code = null, productId = null, quantity = 1 } = {}, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    const qty = Math.floor(Number(quantity) || 0);
    if (qty <= 0 || qty > MAX_ADD_QUANTITY) throw httpError(400, 'Количество должно быть больше 0');
    const scan = normalizeBarcode(code);
    const directProductId = productId != null && productId !== '' ? requireId(productId, 'Некорректный товар') : null;
    if (!scan && !directProductId) throw httpError(400, 'Отсканируйте товар');
    if (scan && !directProductId && looksLikeCis(scan) && qty !== 1) {
      throw httpError(400, 'Код маркировки сканируется поштучно');
    }

    const result = await transaction(async (client) => {
      const place = await lockPlaceInTx(client, cid, pid);
      const batchId = Number(place.batch_id);

      if (scan && !directProductId) {
        const otherPlace = await client.query(
          `SELECT id FROM cargo_places WHERE batch_id = $1 AND barcode = $2`,
          [batchId, scan]
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
        resolvedProductId = await resolveProductIdInTx(client, scan, pid);
        if (!resolvedProductId) {
          throw httpError(
            404,
            looksLikeCis(scan) ? 'Товар не найден по GTIN из кода маркировки' : 'Товар не найден по скану',
            'PRODUCT_NOT_FOUND'
          );
        }
      } else {
        const own = await client.query(`SELECT 1 FROM products WHERE id = $1 AND profile_id = $2`, [
          resolvedProductId,
          pid,
        ]);
        if (!own.rows?.length) throw httpError(403, 'Товар недоступен в вашем аккаунте');
      }

      const cur = await client.query(
        `SELECT quantity FROM cargo_place_items WHERE cargo_place_id = $1 AND product_id = $2`,
        [cid, resolvedProductId]
      );
      const nextQty = (Number(cur.rows?.[0]?.quantity) || 0) + qty;
      await setPlaceItemQuantityInTx(client, cid, resolvedProductId, nextQty);
      if (place.status === 'closed') {
        await client.query(
          `UPDATE cargo_places
           SET status = 'opened', closed_at = NULL, closed_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [cid]
        );
      }
      await client.query(`UPDATE cargo_batches SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [batchId]);
      const pr = await client.query(`SELECT name, sku FROM products WHERE id = $1`, [resolvedProductId]);
      return {
        batchId,
        product: {
          id: resolvedProductId,
          name: pr.rows?.[0]?.name,
          sku: pr.rows?.[0]?.sku,
        },
        added: qty,
      };
    });

    return { ...result, ...(await this.getPlace(cid, { profileId: pid })) };
  }

  async setItemQuantity(placeId, { productId, quantity } = {}, { profileId } = {}) {
    const pid = requireProfileId(profileId);
    const cid = requireId(placeId, 'Некорректный ID грузоместа');
    const productIdNum = requireId(productId, 'Укажите товар');
    const qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty) || qty < 0 || qty > MAX_ADD_QUANTITY) throw httpError(400, 'Некорректное количество');

    await transaction(async (client) => {
      const place = await lockPlaceInTx(client, cid, pid);
      assertPlaceEditable(place);
      await setPlaceItemQuantityInTx(client, cid, productIdNum, qty);
      await client.query(`UPDATE cargo_batches SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [
        place.batch_id,
      ]);
    });
    return this.getPlace(cid, { profileId: pid });
  }

  /** Оформить приёмку на склад и сохранить отчёт по грузоместам. */
  async complete(batchId, { supplierId = null, organizationId = null } = {}, { profileId, userId } = {}) {
    const pid = requireProfileId(profileId);
    const id = requireId(batchId, 'Некорректный ID пакета');
    const uid = optionalUserId(userId);

    const batch = await transaction(async (client) => {
      const row = await lockBatchInTx(client, id, pid);
      assertBatchOpen(row);
      if (uid != null && row.created_by_user_id != null && Number(row.created_by_user_id) !== uid) {
        throw httpError(403, 'Оформить приёмку может только сотрудник, который её начал');
      }
      const opened = await client.query(
        `SELECT COUNT(*)::int AS n FROM cargo_places WHERE batch_id = $1 AND status = 'opened'`,
        [id]
      );
      if (Number(opened.rows?.[0]?.n) > 0) {
        throw httpError(400, 'Сначала закройте все открытые грузоместа');
      }
      const linesR = await client.query(
        `SELECT ci.product_id, SUM(ci.quantity)::int AS quantity
         FROM cargo_place_items ci
         JOIN cargo_places cp ON cp.id = ci.cargo_place_id
         WHERE cp.batch_id = $1
         GROUP BY ci.product_id`,
        [id]
      );
      if (!linesR.rows?.length) throw httpError(400, 'Нет товара для оформления — примите товар из грузомест');
      return {
        row,
        lines: linesR.rows.map((r) => ({
          productId: Number(r.product_id),
          quantity: Number(r.quantity) || 0,
        })),
      };
    });

    const orgId =
      organizationId != null && organizationId !== ''
        ? Number(organizationId)
        : batch.row.organization_id != null
          ? Number(batch.row.organization_id)
          : null;
    const sid = supplierId != null && supplierId !== '' ? Number(supplierId) : batch.row.supplier_id;

    const created = await warehouseReceiptsService.createReceipt({
      supplierId: sid,
      organizationId: orgId,
      warehouseId: Number(batch.row.warehouse_id),
      lines: batch.lines,
    });
    const receiptRow = created?.receipt || created;
    const receiptId = Number(receiptRow?.id ?? receiptRow?.receipt_id);
    if (!receiptId) throw httpError(500, 'Приёмка создана, но не удалось получить её ID');

    await query(
      `UPDATE cargo_batches
       SET status = 'completed', warehouse_receipt_id = $2, supplier_id = COALESCE($3, supplier_id),
           completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id, receiptId, sid != null && Number.isFinite(Number(sid)) ? Number(sid) : null]
    );
    await query(
      `UPDATE cargo_places SET status = 'closed',
         closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
       WHERE batch_id = $1 AND status <> 'closed'`,
      [id]
    );

    const state = await this.getBatch(id, { profileId: pid });
    return { ...state, receipt: receiptRow };
  }
}

export default new CargoBatchesService();
