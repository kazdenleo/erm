/**
 * Сбор этикеток FBO: скан товара/комплектующей → +1 к collected, печать этикетки строки поставки.
 * Несколько пользователей могут работать по одной поставке (атомарный счётчик + журнал).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { looksLikeCis, productLookupCodesFromScan } from '../utils/chestnyZnak.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

function normalizeBarcode(v) {
  return String(v || '').trim();
}

function normalizeUserId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mapItemCollectRow(row) {
  const planned = Math.max(0, parseInt(row.quantity, 10) || 0);
  const collected = Math.max(0, parseInt(row.collected_quantity, 10) || 0);
  return {
    id: Number(row.id),
    fboSupplyId: Number(row.fbo_supply_id),
    productId: row.product_id != null ? Number(row.product_id) : null,
    sku: row.sku || row.product_sku || null,
    barcode: row.barcode || null,
    name: row.name || row.product_name || null,
    productName: row.product_name || null,
    productImage: row.product_image || null,
    planned,
    collected,
    remaining: Math.max(0, planned - collected),
    complete: planned > 0 && collected >= planned,
    over: collected > planned,
  };
}

async function assertSupplyAccess(supplyId, profileId) {
  const pid = normalizeProfileId(profileId);
  const r = await query(
    `SELECT id, marketplace, profile_id, status, external_shipment_number
     FROM fbo_supplies
     WHERE id = $1 AND ($2::bigint IS NULL OR profile_id = $2)
     LIMIT 1`,
    [supplyId, pid]
  );
  if (!r.rows?.length) {
    const err = new Error('Поставка FBO не найдена');
    err.statusCode = 404;
    throw err;
  }
  return r.rows[0];
}

const ITEM_SELECT = `
  i.id, i.fbo_supply_id, i.product_id, i.quantity, i.collected_quantity,
  i.sku, i.barcode, i.name,
  p.sku AS product_sku, p.name AS product_name,
  (SELECT elem->>'url' FROM jsonb_array_elements(COALESCE(p.images, '[]'::jsonb)) AS elem LIMIT 1) AS product_image
`;

async function findSupplyItemDirect(supplyId, barcode, profileId) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;

  const directR = await query(
    `SELECT ${ITEM_SELECT}
     FROM fbo_supply_items i
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.fbo_supply_id = $1
       AND (
         TRIM(COALESCE(i.barcode, '')) = $2
         OR TRIM(COALESCE(i.sku, '')) = $2
       )
     LIMIT 1`,
    [supplyId, code]
  );
  if (directR.rows?.[0]) {
    return { item: directR.rows[0], scannedProductId: directR.rows[0].product_id, match: 'direct' };
  }

  const pid = normalizeProfileId(profileId);
  const params = [supplyId, code];
  let profileFilter = '';
  if (pid != null) {
    params.push(pid);
    profileFilter = ` AND p.profile_id = $${params.length}`;
  }
  const byProductR = await query(
    `SELECT ${ITEM_SELECT}
     FROM fbo_supply_items i
     JOIN products p ON p.id = i.product_id
     WHERE i.fbo_supply_id = $1${profileFilter}
       AND (
         TRIM(COALESCE(p.sku, '')) = $2
         OR EXISTS (
           SELECT 1 FROM barcodes b
           WHERE b.product_id = p.id AND TRIM(b.barcode) = $2
         )
         OR EXISTS (
           SELECT 1 FROM product_skus ps
           WHERE ps.product_id = p.id AND TRIM(ps.sku) = $2
         )
       )
     LIMIT 1`,
    params
  );
  if (byProductR.rows?.[0]) {
    return {
      item: byProductR.rows[0],
      scannedProductId: byProductR.rows[0].product_id,
      match: 'product',
    };
  }
  return null;
}

/** Скан комплектующей → строка поставки с комплектом, в состав которого входит товар. */
async function findSupplyItemByKitComponent(supplyId, barcode, profileId) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;

  const pid = normalizeProfileId(profileId);
  const params = [supplyId, code];
  let profileFilter = '';
  if (pid != null) {
    params.push(pid);
    profileFilter = ` AND (comp.profile_id = $${params.length} OR kit.profile_id = $${params.length})`;
  }

  const r = await query(
    `SELECT ${ITEM_SELECT},
            kc.component_product_id AS scanned_component_id,
            comp.sku AS scanned_component_sku
     FROM fbo_supply_items i
     JOIN products kit ON kit.id = i.product_id
     JOIN kit_components kc ON kc.kit_product_id = kit.id
     JOIN products comp ON comp.id = kc.component_product_id
     WHERE i.fbo_supply_id = $1${profileFilter}
       AND (
         TRIM(COALESCE(comp.sku, '')) = $2
         OR EXISTS (
           SELECT 1 FROM barcodes b
           WHERE b.product_id = comp.id AND TRIM(b.barcode) = $2
         )
         OR EXISTS (
           SELECT 1 FROM product_skus ps
           WHERE ps.product_id = comp.id AND TRIM(ps.sku) = $2
         )
       )
     ORDER BY i.id ASC
     LIMIT 1`,
    params
  );
  if (!r.rows?.[0]) return null;
  return {
    item: r.rows[0],
    scannedProductId: r.rows[0].scanned_component_id,
    match: 'kit_component',
    scannedComponentSku: r.rows[0].scanned_component_sku || null,
  };
}

async function resolveScanToSupplyItem(supplyId, barcode, profileId) {
  const codes = productLookupCodesFromScan(barcode);
  const toTry = codes.length ? codes : [normalizeBarcode(barcode)];
  for (const code of toTry) {
    const direct = await findSupplyItemDirect(supplyId, code, profileId);
    if (direct) return direct;
    const viaKit = await findSupplyItemByKitComponent(supplyId, code, profileId);
    if (viaKit) return viaKit;
  }
  return null;
}

class FboSuppliesCollectService {
  async getCollectState(supplyId, { profileId } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Сбор этикеток доступен только с PostgreSQL');
      err.statusCode = 503;
      throw err;
    }
    await assertSupplyAccess(supplyId, profileId);

    const itemsR = await query(
      `SELECT ${ITEM_SELECT}
       FROM fbo_supply_items i
       LEFT JOIN products p ON p.id = i.product_id
       WHERE i.fbo_supply_id = $1
       ORDER BY
         CASE
           WHEN COALESCE(i.collected_quantity, 0) >= i.quantity THEN 2
           WHEN COALESCE(i.collected_quantity, 0) > 0 THEN 0
           ELSE 1
         END,
         i.id ASC`,
      [supplyId]
    );
    const items = (itemsR.rows || []).map(mapItemCollectRow);

    const recentR = await query(
      `SELECT s.id, s.fbo_supply_item_id, s.product_id, s.scanned_product_id, s.barcode,
              s.user_id, s.user_name, s.created_at,
              i.sku AS item_sku
       FROM fbo_supply_item_scans s
       LEFT JOIN fbo_supply_items i ON i.id = s.fbo_supply_item_id
       WHERE s.fbo_supply_id = $1
         AND s.created_at > NOW() - INTERVAL '30 minutes'
       ORDER BY s.created_at DESC
       LIMIT 40`,
      [supplyId]
    );

    const activeUsersMap = new Map();
    for (const row of recentR.rows || []) {
      const uid = row.user_id != null ? String(row.user_id) : row.user_name || 'anon';
      if (!activeUsersMap.has(uid)) {
        activeUsersMap.set(uid, {
          userId: row.user_id != null ? Number(row.user_id) : null,
          userName: row.user_name || (row.user_id != null ? `Пользователь #${row.user_id}` : 'Сотрудник'),
          lastScanAt: row.created_at,
        });
      }
    }

    const plannedTotal = items.reduce((s, it) => s + it.planned, 0);
    const collectedTotal = items.reduce((s, it) => s + it.collected, 0);

    return {
      items,
      plannedTotal,
      collectedTotal,
      completeCount: items.filter((it) => it.complete).length,
      itemCount: items.length,
      activeUsers: [...activeUsersMap.values()],
      recentScans: (recentR.rows || []).map((row) => ({
        id: Number(row.id),
        supplyItemId: Number(row.fbo_supply_item_id),
        productId: row.product_id != null ? Number(row.product_id) : null,
        scannedProductId: row.scanned_product_id != null ? Number(row.scanned_product_id) : null,
        barcode: row.barcode || null,
        itemSku: row.item_sku || null,
        userId: row.user_id != null ? Number(row.user_id) : null,
        userName: row.user_name || null,
        createdAt: row.created_at,
      })),
    };
  }

  async scan(
    supplyId,
    { barcode, allowOverage = false } = {},
    { profileId, userId, userName } = {}
  ) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      const err = new Error('Сбор этикеток доступен только с PostgreSQL');
      err.statusCode = 503;
      throw err;
    }
    const supply = await assertSupplyAccess(supplyId, profileId);
    const code = normalizeBarcode(barcode);
    if (!code) {
      const err = new Error('Отсканируйте штрихкод или артикул');
      err.statusCode = 400;
      throw err;
    }
    if (looksLikeCis(code)) {
      const err = new Error('Это код «Честный знак». Отсканируйте штрихкод или артикул товара.');
      err.statusCode = 400;
      err.code = 'CIS_NOT_PRODUCT';
      throw err;
    }

    const resolved = await resolveScanToSupplyItem(supplyId, code, profileId);
    if (!resolved?.item) {
      const err = new Error('Товар не найден в этой поставке (ни как позиция, ни как комплектующая комплекта)');
      err.statusCode = 404;
      err.code = 'COLLECT_ITEM_NOT_FOUND';
      throw err;
    }

    const itemId = Number(resolved.item.id);
    const planned = Math.max(0, parseInt(resolved.item.quantity, 10) || 0);
    const collectedBefore = Math.max(0, parseInt(resolved.item.collected_quantity, 10) || 0);

    if (!allowOverage && collectedBefore >= planned) {
      const err = new Error(
        `Позиция уже собрана полностью (${collectedBefore} из ${planned}). Больше не нужно добавлять этот товар в поставку.`
      );
      err.statusCode = 409;
      err.code = 'COLLECT_OVERAGE';
      err.details = {
        supplyItemId: itemId,
        productId: resolved.item.product_id != null ? Number(resolved.item.product_id) : null,
        planned,
        collected: collectedBefore,
        sku: resolved.item.sku || resolved.item.product_sku || null,
        name: resolved.item.name || resolved.item.product_name || null,
      };
      throw err;
    }

    const upd = await query(
      `UPDATE fbo_supply_items
       SET collected_quantity = collected_quantity + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND fbo_supply_id = $2
       RETURNING id, fbo_supply_id, product_id, quantity, collected_quantity, sku, barcode, name`,
      [itemId, supplyId]
    );
    const updated = upd.rows?.[0];
    if (!updated) {
      const err = new Error('Не удалось обновить счётчик сбора');
      err.statusCode = 500;
      throw err;
    }

    const uid = normalizeUserId(userId);
    const uname =
      userName != null && String(userName).trim() !== ''
        ? String(userName).trim().slice(0, 200)
        : null;

    await query(
      `INSERT INTO fbo_supply_item_scans
         (fbo_supply_id, fbo_supply_item_id, product_id, scanned_product_id, barcode, user_id, user_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        supplyId,
        itemId,
        updated.product_id,
        resolved.scannedProductId != null ? Number(resolved.scannedProductId) : null,
        code.slice(0, 256),
        uid,
        uname,
      ]
    );

    const state = await this.getCollectState(supplyId, { profileId });
    const item = state.items.find((it) => it.id === itemId) || mapItemCollectRow({
      ...updated,
      product_sku: resolved.item.product_sku,
      product_name: resolved.item.product_name,
      product_image: resolved.item.product_image,
    });

    const printProductId = updated.product_id != null ? Number(updated.product_id) : null;
    if (!printProductId) {
      const err = new Error('У позиции поставки нет привязанного товара — этикетку напечатать нельзя');
      err.statusCode = 400;
      err.code = 'NO_PRODUCT_FOR_LABEL';
      throw err;
    }

    return {
      action: 'collected',
      match: resolved.match,
      scannedComponentSku: resolved.scannedComponentSku || null,
      overage: item.collected > item.planned,
      warning:
        item.collected > item.planned
          ? `Собрано больше плана: ${item.collected} из ${item.planned}`
          : item.collected === item.planned
            ? `Позиция собрана полностью (${item.collected} из ${item.planned})`
            : null,
      print: {
        productId: printProductId,
        copies: 1,
        marketplace: supply.marketplace || null,
        title: item.sku || item.name || `#${printProductId}`,
      },
      item,
      state,
    };
  }
}

export default new FboSuppliesCollectService();
