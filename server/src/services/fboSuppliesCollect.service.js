/**
 * Сбор этикеток FBO: скан → прогресс; печать этикетки строки поставки
 * только для обычного товара, SKU комплекта целиком или когда собраны все комплектующие.
 */

import { query, getClient } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { looksLikeCis, productLookupCodesFromScan } from '../utils/chestnyZnak.js';
import {
  isKitProductId,
  getKitComponents,
  aggregateKitComponents,
} from './kitStock.service.js';

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

function parseProgress(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = Number(k);
    const n = Math.max(0, parseInt(v, 10) || 0);
    if (Number.isFinite(id) && id > 0 && n > 0) out[String(id)] = n;
  }
  return out;
}

function kitsCompletableFromProgress(progress, aggregatedComponents) {
  if (!aggregatedComponents?.length) return 0;
  let min = Infinity;
  for (const c of aggregatedComponents) {
    const need = Math.max(1, parseInt(c.quantity, 10) || 1);
    const got = Math.max(0, parseInt(progress[String(c.component_product_id)], 10) || 0);
    min = Math.min(min, Math.floor(got / need));
  }
  return Number.isFinite(min) && min > 0 ? min : 0;
}

function subtractKitsFromProgress(progress, aggregatedComponents, kits) {
  const next = { ...progress };
  const n = Math.max(0, Math.floor(Number(kits) || 0));
  if (n <= 0) return next;
  for (const c of aggregatedComponents || []) {
    const cid = String(c.component_product_id);
    const need = Math.max(1, parseInt(c.quantity, 10) || 1);
    const got = Math.max(0, parseInt(next[cid], 10) || 0);
    const left = Math.max(0, got - need * n);
    if (left > 0) next[cid] = left;
    else delete next[cid];
  }
  return next;
}

function kitProgressSummary(progress, aggregatedComponents) {
  if (!aggregatedComponents?.length) return null;
  let scannedPieces = 0;
  let needPieces = 0;
  const lines = [];
  for (const c of aggregatedComponents) {
    const need = Math.max(1, parseInt(c.quantity, 10) || 1);
    const got = Math.max(0, parseInt(progress[String(c.component_product_id)], 10) || 0);
    needPieces += need;
    scannedPieces += Math.min(got, need);
    lines.push({
      componentProductId: Number(c.component_product_id),
      sku: c.sku || null,
      name: c.name || null,
      need,
      got: Math.min(got, need),
    });
  }
  return {
    scannedPieces,
    needPieces,
    lines,
    completeUnitsReady: kitsCompletableFromProgress(progress, aggregatedComponents),
  };
}

function mapItemCollectRow(row, kitMeta = null) {
  const planned = Math.max(0, parseInt(row.quantity, 10) || 0);
  const collected = Math.max(0, parseInt(row.collected_quantity, 10) || 0);
  const progress = parseProgress(row.collect_component_progress);
  const base = {
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
    isKit: kitMeta?.isKit === true,
    kitComponents: null,
    kitProgress: null,
  };
  if (kitMeta?.isKit && kitMeta.components?.length) {
    base.kitComponents = kitMeta.components.map((c) => ({
      productId: Number(c.component_product_id),
      sku: c.sku || null,
      name: c.name || null,
      need: Math.max(1, parseInt(c.quantity, 10) || 1),
      got: Math.min(
        Math.max(0, parseInt(progress[String(c.component_product_id)], 10) || 0),
        Math.max(1, parseInt(c.quantity, 10) || 1)
      ),
    }));
    base.kitProgress = kitProgressSummary(progress, kitMeta.components);
  }
  return base;
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
  i.collect_component_progress, i.sku, i.barcode, i.name,
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

async function findSupplyItemByKitComponent(supplyId, barcode, profileId) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;

  const pid = normalizeProfileId(profileId);
  const params = [supplyId, code];
  let profileFilter = '';
  if (pid != null) {
    params.push(pid);
    profileFilter = ` AND (comp.profile_id = $${params.length} OR p.profile_id = $${params.length})`;
  }

  const r = await query(
    `SELECT ${ITEM_SELECT},
            kc.component_product_id AS scanned_component_id,
            comp.sku AS scanned_component_sku
     FROM fbo_supply_items i
     JOIN products p ON p.id = i.product_id
     JOIN kit_components kc ON kc.kit_product_id = p.id
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

async function loadKitMetaMap(productIds) {
  const map = new Map();
  const ids = [...new Set((productIds || []).map((id) => Number(id)).filter((n) => n > 0))];
  const allCompIds = new Set();
  await Promise.all(
    ids.map(async (pid) => {
      const isKit = await isKitProductId(pid);
      if (!isKit) {
        map.set(pid, { isKit: false, components: [] });
        return;
      }
      const components = aggregateKitComponents(await getKitComponents(pid));
      for (const c of components) allCompIds.add(Number(c.component_product_id));
      map.set(pid, { isKit: true, components });
    })
  );
  const skuById = new Map();
  const compIds = [...allCompIds];
  if (compIds.length) {
    const r = await query(
      `SELECT id, sku, name FROM products WHERE id = ANY($1::bigint[])`,
      [compIds]
    );
    for (const row of r.rows || []) {
      skuById.set(Number(row.id), {
        sku: row.sku != null ? String(row.sku).trim() : null,
        name: row.name != null ? String(row.name).trim() : null,
      });
    }
  }
  for (const meta of map.values()) {
    if (!meta.isKit) continue;
    meta.components = (meta.components || []).map((c) => {
      const info = skuById.get(Number(c.component_product_id)) || {};
      return {
        ...c,
        sku: info.sku || null,
        name: info.name || null,
      };
    });
  }
  return map;
}

async function insertScanLog({
  supplyId,
  itemId,
  productId,
  scannedProductId,
  barcode,
  userId,
  userName,
  client = null,
}) {
  const run = client?.query ? client.query.bind(client) : query;
  const uid = normalizeUserId(userId);
  const uname =
    userName != null && String(userName).trim() !== ''
      ? String(userName).trim().slice(0, 200)
      : null;
  await run(
    `INSERT INTO fbo_supply_item_scans
       (fbo_supply_id, fbo_supply_item_id, product_id, scanned_product_id, barcode, user_id, user_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      supplyId,
      itemId,
      productId,
      scannedProductId != null ? Number(scannedProductId) : null,
      String(barcode || '').slice(0, 256),
      uid,
      uname,
    ]
  );
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
    const rows = itemsR.rows || [];
    const kitMeta = await loadKitMetaMap(rows.map((r) => r.product_id));
    const items = rows.map((row) => {
      const pid = row.product_id != null ? Number(row.product_id) : null;
      return mapItemCollectRow(row, pid != null ? kitMeta.get(pid) : null);
    });

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
    const kitProductId = resolved.item.product_id != null ? Number(resolved.item.product_id) : null;
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
        productId: kitProductId,
        planned,
        collected: collectedBefore,
        sku: resolved.item.sku || resolved.item.product_sku || null,
        name: resolved.item.name || resolved.item.product_name || null,
      };
      throw err;
    }

    const isKit = kitProductId != null ? await isKitProductId(kitProductId) : false;
    const components = isKit
      ? aggregateKitComponents(await getKitComponents(kitProductId))
      : [];
    const isComponentScan = resolved.match === 'kit_component' && isKit && components.length > 0;
    const isWholeKitScan =
      isKit &&
      components.length > 0 &&
      (resolved.match === 'direct' || resolved.match === 'product') &&
      Number(resolved.scannedProductId) === kitProductId;

    let unitsCompleted = 0;
    let updatedRow = null;
    let progressAfter = parseProgress(resolved.item.collect_component_progress);
    let action = 'collected';
    let message = null;

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id, fbo_supply_id, product_id, quantity, collected_quantity,
                collect_component_progress, sku, barcode, name
         FROM fbo_supply_items
         WHERE id = $1 AND fbo_supply_id = $2
         FOR UPDATE`,
        [itemId, supplyId]
      );
      const lockedRow = locked.rows?.[0];
      if (!lockedRow) {
        const err = new Error('Строка поставки не найдена');
        err.statusCode = 404;
        throw err;
      }

      const plannedLocked = Math.max(0, parseInt(lockedRow.quantity, 10) || 0);
      let collectedLocked = Math.max(0, parseInt(lockedRow.collected_quantity, 10) || 0);
      let progress = parseProgress(lockedRow.collect_component_progress);

      if (!allowOverage && collectedLocked >= plannedLocked) {
        const err = new Error(
          `Позиция уже собрана полностью (${collectedLocked} из ${plannedLocked}). Больше не нужно добавлять этот товар в поставку.`
        );
        err.statusCode = 409;
        err.code = 'COLLECT_OVERAGE';
        err.details = {
          supplyItemId: itemId,
          productId: kitProductId,
          planned: plannedLocked,
          collected: collectedLocked,
          sku: lockedRow.sku || resolved.item.product_sku || null,
          name: lockedRow.name || resolved.item.product_name || null,
        };
        throw err;
      }

      if (isComponentScan) {
        const compId = Number(resolved.scannedProductId);
        const perKit =
          components.find((c) => Number(c.component_product_id) === compId)?.quantity || 1;
        const key = String(compId);
        const beforeCompletable = kitsCompletableFromProgress(progress, components);
        progress[key] = (progress[key] || 0) + 1;
        const afterCompletable = kitsCompletableFromProgress(progress, components);
        unitsCompleted = Math.max(0, afterCompletable - beforeCompletable);

        if (unitsCompleted > 0) {
          const room = allowOverage
            ? unitsCompleted
            : Math.min(unitsCompleted, Math.max(0, plannedLocked - collectedLocked));
          if (room <= 0 && !allowOverage) {
            progress[key] = Math.max(0, (progress[key] || 0) - 1);
            if (progress[key] === 0) delete progress[key];
            const err = new Error(
              `Позиция уже собрана полностью (${collectedLocked} из ${plannedLocked}). Больше не нужно добавлять этот товар в поставку.`
            );
            err.statusCode = 409;
            err.code = 'COLLECT_OVERAGE';
            throw err;
          }
          const applyUnits = allowOverage ? unitsCompleted : room;
          progress = subtractKitsFromProgress(progress, components, applyUnits);
          collectedLocked += applyUnits;
          unitsCompleted = applyUnits;
          action = 'collected';
          message =
            applyUnits === 1
              ? `Комплект собран — этикетка на печать (${collectedLocked} из ${plannedLocked})`
              : `Собрано комплектов: ${applyUnits} — этикетки на печать (${collectedLocked} из ${plannedLocked})`;
        } else {
          action = 'kit_progress';
          const summary = kitProgressSummary(progress, components);
          message = `Комплектующая принята${
            resolved.scannedComponentSku ? ` (${resolved.scannedComponentSku})` : ''
          }: ${summary.scannedPieces} из ${summary.needPieces} для следующего комплекта. Этикетка пока не печатается.`;
        }
      } else if (isWholeKitScan || !isKit || components.length === 0) {
        // Обычный товар или скан SKU комплекта целиком → сразу +1 и печать
        unitsCompleted = 1;
        collectedLocked += 1;
        if (isWholeKitScan) {
          // Целый комплект: сбрасываем незавершённый прогресс комплектующих текущего «слота»
          progress = {};
        }
        action = 'collected';
        message = isWholeKitScan
          ? `Отсканирован комплект целиком (${collectedLocked} из ${plannedLocked})`
          : `Собрано ${collectedLocked} из ${plannedLocked}`;
      } else {
        // Комплект без состава в БД — как обычный товар
        unitsCompleted = 1;
        collectedLocked += 1;
        action = 'collected';
        message = `Собрано ${collectedLocked} из ${plannedLocked}`;
      }

      const upd = await client.query(
        `UPDATE fbo_supply_items
         SET collected_quantity = $3,
             collect_component_progress = $4::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND fbo_supply_id = $2
         RETURNING id, fbo_supply_id, product_id, quantity, collected_quantity,
                   collect_component_progress, sku, barcode, name`,
        [itemId, supplyId, collectedLocked, JSON.stringify(progress)]
      );
      updatedRow = upd.rows?.[0];
      progressAfter = progress;

      await insertScanLog({
        supplyId,
        itemId,
        productId: updatedRow.product_id,
        scannedProductId: resolved.scannedProductId,
        barcode: code,
        userId,
        userName,
        client,
      });

      await client.query('COMMIT');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }

    const state = await this.getCollectState(supplyId, { profileId });
    const item =
      state.items.find((it) => it.id === itemId) ||
      mapItemCollectRow(
        {
          ...updatedRow,
          product_sku: resolved.item.product_sku,
          product_name: resolved.item.product_name,
          product_image: resolved.item.product_image,
        },
        { isKit, components }
      );

    const printProductId = updatedRow?.product_id != null ? Number(updatedRow.product_id) : null;
    const shouldPrint = action === 'collected' && unitsCompleted > 0 && printProductId;

    if (action === 'collected' && !printProductId) {
      const err = new Error('У позиции поставки нет привязанного товара — этикетку напечатать нельзя');
      err.statusCode = 400;
      err.code = 'NO_PRODUCT_FOR_LABEL';
      throw err;
    }

    return {
      action,
      match: resolved.match,
      scannedComponentSku: resolved.scannedComponentSku || null,
      unitsCompleted,
      kitProgress: isKit ? kitProgressSummary(progressAfter, components) : null,
      overage: item.collected > item.planned,
      warning:
        item.collected > item.planned
          ? `Собрано больше плана: ${item.collected} из ${item.planned}`
          : item.collected === item.planned && action === 'collected'
            ? `Позиция собрана полностью (${item.collected} из ${item.planned})`
            : message,
      message,
      print: shouldPrint
        ? {
            productId: printProductId,
            copies: Math.max(1, unitsCompleted),
            marketplace: supply.marketplace || null,
            title: item.sku || item.name || `#${printProductId}`,
          }
        : null,
      item,
      state,
    };
  }
}

export default new FboSuppliesCollectService();
