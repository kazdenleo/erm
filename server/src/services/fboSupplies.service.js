/**
 * Поставки FBO на склады маркетплейсов.
 */

import { query, transaction } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { FBO_SUPPLY_STATUSES, getNextFboSupplyStatus } from '../constants/fboSupplyStatuses.js';
import stockMovementsService from './stockMovements.service.js';
import fboSupplyReserveService from './fboSupplyReserve.service.js';
import { resolveDefaultFboDeductionWarehouseId } from '../utils/fboProfileDefaults.js';
import {
  assertCanSetPackedStatus,
  assertCanSetReadyForSupply,
  evaluateSupplyPacking,
  syncSupplyStatusForPacking,
} from '../utils/fboSupplyPackingCheck.js';
import {
  pickBarcodeForMarketplace,
  parseBarcodesMarketplacesColumn,
} from '../utils/productBarcodes.js';

const FBO_RESERVE_TERMINAL_STATUSES = new Set(['shipped', 'closed', 'return']);

function isStatusOnlyUpdate(payload) {
  if (!payload || payload.status === undefined) return false;
  const keys = Object.keys(payload).filter((k) => payload[k] !== undefined);
  return keys.length === 1 && keys[0] === 'status';
}

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

function normalizeMarketplace(mp) {
  const m = String(mp || 'ozon').toLowerCase();
  if (m === 'wildberries' || m === 'wb') return 'wb';
  if (m === 'yandex' || m === 'ym' || m === 'yandexmarket') return 'ym';
  return 'ozon';
}

function mapSupplyRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profileId: row.profile_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name ?? null,
    createdByUserId: row.created_by_user_id,
    status: row.status,
    marketplace: row.marketplace,
    name: row.name,
    readyAt: row.ready_at,
    marketplaceWarehouseName: row.marketplace_warehouse_name,
    marketplaceWarehouseId: row.marketplace_warehouse_id,
    placementCluster: row.placement_cluster ?? null,
    externalShipmentNumber: row.external_shipment_number,
    externalSupplyId: row.external_supply_id,
    deductionWarehouseId: row.deduction_warehouse_id,
    deductionWarehouseName: row.deduction_warehouse_name ?? null,
    deductStock: row.deduct_stock,
    stockDeductedAt: row.stock_deducted_at ?? null,
    source: row.source,
    note: row.note,
    pendingMpContentUpdate: row.pending_mp_content_update === true,
    marketplaceContentSyncedAt: row.marketplace_content_synced_at ?? null,
    itemCount: row.items_quantity_total != null ? Number(row.items_quantity_total) : undefined,
    itemsLineCount: row.items_line_count != null ? Number(row.items_line_count) : undefined,
    reservedFromStockTotal:
      row.reserved_from_stock_total != null
        ? Number(row.reserved_from_stock_total)
        : row.reservedFromStockTotal ?? undefined,
    reservedFromIncomingTotal:
      row.reserved_from_incoming_total != null
        ? Number(row.reserved_from_incoming_total)
        : row.reservedFromIncomingTotal ?? undefined,
    items: row.items,
  };
}

function parseOzonTagsJson(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((t) => String(t).trim()).filter(Boolean);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parseOzonTagsJson(parsed);
    } catch {
      /* ignore */
    }
  }
  return [];
}

function mapItemRow(row) {
  return {
    id: row.id,
    fboSupplyId: row.fbo_supply_id,
    productId: row.product_id,
    quantity: row.quantity,
    marketplaceQuantity: row.mp_quantity != null ? Number(row.mp_quantity) : null,
    reservedQuantity:
      row.reserved_quantity != null ? Number(row.reserved_quantity) : row.reservedQuantity ?? undefined,
    reservedFromStock:
      row.reserved_from_stock != null
        ? Number(row.reserved_from_stock)
        : row.reservedFromStock ?? undefined,
    reservedFromIncoming:
      row.reserved_from_incoming != null
        ? Number(row.reserved_from_incoming)
        : row.reservedFromIncoming ?? undefined,
    reservedTotal:
      row.reserved_total != null ? Number(row.reserved_total) : row.reservedTotal ?? undefined,
    barcode: row.barcode,
    sku: row.sku,
    mpOfferId: row.mp_offer_id,
    mpProductId: row.mp_product_id,
    name: row.name,
    productName: row.product_name ?? null,
    productImage: row.product_image ?? null,
    productCategoryId: row.product_category_id ?? null,
    placementZone: row.placement_zone != null ? String(row.placement_zone).trim() : null,
    ozonTags: parseOzonTagsJson(row.ozon_tags),
  };
}

const SUPPLY_SELECT = `
  SELECT s.*,
         o.name AS organization_name,
         COALESCE(NULLIF(TRIM(w.address), ''), 'Склад #' || w.id::text) AS deduction_warehouse_name,
         (SELECT COALESCE(SUM(i.quantity), 0)::int FROM fbo_supply_items i WHERE i.fbo_supply_id = s.id) AS items_quantity_total,
         (SELECT COUNT(*)::int FROM fbo_supply_items i WHERE i.fbo_supply_id = s.id) AS items_line_count
  FROM fbo_supplies s
  LEFT JOIN organizations o ON o.id = s.organization_id
  LEFT JOIN warehouses w ON w.id = s.deduction_warehouse_id
`;

class FboSuppliesService {
  /**
   * Склады для списания остатков в поставке FBO (свои склады профиля, без складов поставщиков).
   */
  async listDeductionWarehouses({ profileId, organizationId = null } = {}) {
    const pid = normalizeProfileId(profileId);
    const orgId =
      organizationId != null && organizationId !== '' && Number.isFinite(Number(organizationId))
        ? Number(organizationId)
        : null;
    const r = await query(
      `
      SELECT w.id, w.type, w.address, w.supplier_id, w.organization_id, w.wb_warehouse_name, w.is_fbo_stock
      FROM warehouses w
      WHERE ($1::bigint IS NULL OR w.profile_id = $1)
        AND LOWER(TRIM(COALESCE(w.type, ''))) = 'warehouse'
        AND w.supplier_id IS NULL
        AND (
          $2::bigint IS NULL
          OR w.organization_id IS NULL
          OR w.organization_id = $2
        )
      ORDER BY NULLIF(TRIM(w.wb_warehouse_name), ''), NULLIF(TRIM(w.address), ''), w.id
      `,
      [pid, orgId]
    );
    return (r.rows || []).map((row) => ({
      id: Number(row.id),
      type: row.type,
      address: row.address,
      supplierId: row.supplier_id,
      organizationId: row.organization_id,
      wbWarehouseName: row.wb_warehouse_name || null,
      isFboStock: !!row.is_fbo_stock,
    }));
  }

  async _alreadyDeductedStock(supplyId, client = null) {
    const run = client?.query ? client.query.bind(client) : query;
    const r = await run(
      `SELECT stock_deducted_at FROM fbo_supplies WHERE id = $1 LIMIT 1`,
      [supplyId]
    );
    if (r.rows?.[0]?.stock_deducted_at) return true;
    const m = await run(
      `SELECT 1 FROM stock_movements
       WHERE type = 'shipment'
         AND meta->>'fbo_supply_id' = $1
       LIMIT 1`,
      [String(supplyId)]
    );
    return (m.rows?.length ?? 0) > 0;
  }

  /**
   * Списание остатков при статусе «Отгружен», если включён флаг deduct_stock.
   */
  async applyStockDeductionIfNeeded(supplyId, { profileId } = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { applied: false, reason: 'no_postgresql' };
    }
    const supply = await this.getById(supplyId, { profileId });
    if (supply.status !== 'shipped') {
      return { applied: false, reason: 'not_shipped' };
    }
    if (!supply.deductStock) {
      return { applied: false, reason: 'deduct_disabled' };
    }
    // Резерв снимаем всегда при отгрузке — даже если остаток уже списан ранее.
    // Иначе willDeduct → already_deducted пропускал release, и резерв «залипал».
    await fboSupplyReserveService.releaseReservesForSupply(supplyId, { profileId });

    if (await this._alreadyDeductedStock(supplyId)) {
      return { applied: false, reason: 'already_deducted', stockDeductedAt: supply.stockDeductedAt };
    }
    if (!supply.deductionWarehouseId) {
      const err = new Error('Укажите склад списания остатков перед отгрузкой');
      err.statusCode = 400;
      throw err;
    }

    const whId = Number(supply.deductionWarehouseId);
    const items = (supply.items || []).filter((it) => it.productId && it.quantity > 0);
    if (!items.length) {
      const err = new Error('Нет строк с привязанными товарами для списания');
      err.statusCode = 400;
      throw err;
    }

    const metaBase = {
      fbo_supply_id: String(supply.id),
      marketplace: supply.marketplace,
      external_shipment_number: supply.externalShipmentNumber,
      warehouse_id: whId,
    };

    let deductedLines = 0;
    let skippedLines = 0;
    const errors = [];

    for (const it of items) {
      const pid = Number(it.productId);
      const qty = parseInt(it.quantity, 10);
      if (!pid || !qty || qty <= 0) {
        skippedLines += 1;
        continue;
      }
      try {
        const existing = await query(
          `SELECT COALESCE(SUM(ABS(quantity_change)), 0)::int AS deducted
           FROM stock_movements
           WHERE product_id = $1 AND type = 'shipment'
             AND meta->>'fbo_supply_id' = $2 AND meta->>'fbo_supply_item_id' = $3`,
          [pid, String(supply.id), String(it.id)]
        );
        const already = parseInt(existing.rows?.[0]?.deducted ?? 0, 10) || 0;
        const toShip = Math.max(0, qty - already);
        if (toShip <= 0) {
          skippedLines += 1;
          continue;
        }
        await stockMovementsService.applyChange(pid, {
          delta: -toShip,
          type: 'shipment',
          reason: `FBO поставка №${supply.id}: отгрузка на ${supply.marketplace} (${supply.externalShipmentNumber})`,
          meta: { ...metaBase, fbo_supply_item_id: String(it.id) },
        });
        deductedLines += 1;
      } catch (e) {
        errors.push({ productId: pid, itemId: it.id, message: e?.message || String(e) });
      }
    }

    if (deductedLines === 0 && errors.length) {
      const err = new Error(errors[0].message || 'Не удалось списать остатки');
      err.statusCode = 400;
      err.details = errors;
      throw err;
    }

    await query(
      `UPDATE fbo_supplies SET stock_deducted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [supplyId]
    );

    return {
      applied: deductedLines > 0,
      deductedLines,
      skippedLines,
      errors: errors.length ? errors : undefined,
      stockDeductedAt: new Date().toISOString(),
    };
  }

  /** Уже импортированные ключи поставок (для инкрементальной синхронизации с маркетплейса). */
  async listImportedExternalKeys(marketplace, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    const mp = normalizeMarketplace(marketplace);
    const r = await query(
      `SELECT external_shipment_number, external_supply_id, created_at
       FROM fbo_supplies
       WHERE ($1::bigint IS NULL OR profile_id = $1) AND marketplace = $2`,
      [pid, mp]
    );
    const shipmentNumbers = new Set();
    const supplyIds = new Set();
    let lastImportedAt = null;
    for (const row of r.rows || []) {
      const ext = row.external_shipment_number != null ? String(row.external_shipment_number).trim() : '';
      if (ext) shipmentNumbers.add(`${mp}:${ext}`);
      const sid = row.external_supply_id != null ? String(row.external_supply_id).trim() : '';
      if (sid) supplyIds.add(sid);
      const created = row.created_at ? new Date(row.created_at) : null;
      if (created && (!lastImportedAt || created > lastImportedAt)) {
        lastImportedAt = created;
      }
    }
    return {
      shipmentNumbers,
      supplyIds,
      lastImportedAt,
      count: (r.rows || []).length,
    };
  }

  async findExistingExternalNumbers(pairs, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    const set = new Set();
    if (!pairs?.length) return set;
    const vals = [];
    const params = [pid];
    let idx = 2;
    for (const p of pairs) {
      vals.push(`($${idx}, $${idx + 1})`);
      params.push(normalizeMarketplace(p.marketplace), String(p.externalShipmentNumber));
      idx += 2;
    }
    const r = await query(
      `SELECT marketplace, external_shipment_number
       FROM fbo_supplies
       WHERE ($1::bigint IS NULL OR profile_id = $1)
         AND (marketplace, external_shipment_number) IN (${vals.join(', ')})`,
      params
    );
    for (const row of r.rows || []) {
      set.add(`${row.marketplace}:${row.external_shipment_number}`);
    }
    return set;
  }

  async list({ profileId, limit = 200, status = null, statuses = null, marketplace = null, skipReserveTotals = false } = {}) {
    const pid = normalizeProfileId(profileId);
    const params = [pid];
    let sql = `${SUPPLY_SELECT} WHERE ($1::bigint IS NULL OR s.profile_id = $1)`;
    const statusList = Array.isArray(statuses) && statuses.length > 0
      ? statuses
      : status
        ? [status]
        : [];
    if (statusList.length > 0) {
      params.push(statusList);
      sql += ` AND s.status = ANY($${params.length}::text[])`;
    }
    if (marketplace) {
      params.push(normalizeMarketplace(marketplace));
      sql += ` AND s.marketplace = $${params.length}`;
    }
    params.push(Math.min(500, Math.max(1, parseInt(limit, 10) || 200)));
    sql += ` ORDER BY s.created_at DESC LIMIT $${params.length}`;
    const r = await query(sql, params);
    const rows = (r.rows || []).map(mapSupplyRow);
    if (skipReserveTotals) {
      return rows.map((s) => ({
        ...s,
        reservedFromStockTotal: 0,
        reservedFromIncomingTotal: 0,
      }));
    }
    return fboSupplyReserveService.enrichSuppliesListWithReserveTotals(rows, { profileId: pid });
  }

  async getById(id, { profileId, skipReserveEnrichment = false, skipPackingEval = false } = {}) {
    const pid = normalizeProfileId(profileId);
    const r = await query(
      `${SUPPLY_SELECT} WHERE s.id = $1 AND ($2::bigint IS NULL OR s.profile_id = $2)`,
      [id, pid]
    );
    if (!r.rows?.length) {
      const err = new Error('Поставка FBO не найдена');
      err.statusCode = 404;
      throw err;
    }
    const supply = mapSupplyRow(r.rows[0]);
    // Самолечение: терминал / deduct_stock=off — резерв не должен висеть.
    if (FBO_RESERVE_TERMINAL_STATUSES.has(supply.status) || !supply.deductStock) {
      await fboSupplyReserveService.releaseReservesForSupply(id, { profileId: pid }).catch((e) => {
        console.warn('[FboSupplies] release on getById:', e?.message || e);
      });
    }
    const itemsR = await query(
      `SELECT i.*, p.name AS product_name, p.user_category_id AS product_category_id,
              (SELECT elem->>'url' FROM jsonb_array_elements(COALESCE(p.images, '[]'::jsonb)) AS elem LIMIT 1) AS product_image
       FROM fbo_supply_items i
       LEFT JOIN products p ON p.id = i.product_id
       WHERE i.fbo_supply_id = $1
       ORDER BY i.id ASC`,
      [id]
    );
    const rawItems = (itemsR.rows || []).map(mapItemRow);
    supply.items =
      skipReserveEnrichment === true
        ? rawItems
        : await fboSupplyReserveService.enrichItemsWithReserved(rawItems, {
            profileId: pid,
            reserveEnabled: supply.deductStock === true,
          });
    const packingEval = skipPackingEval ? null : await evaluateSupplyPacking(id);
    if (packingEval) {
      supply.packingAllMatch = packingEval.allMatch;
      supply.hasPackingDiscrepancy = packingEval.hasItems && !packingEval.allMatch;
      supply.packingDiscrepancies = packingEval.discrepancies;
    }
    supply.statusRevertedByPacking = false;
    supply.statusPromotedByPacking = false;
    return supply;
  }

  async create(payload, { profileId, userId, deferReserveRebalance = false, skipReserveRebalance = false, lightReturn = false } = {}) {
    const pid = normalizeProfileId(profileId);
    const mp = normalizeMarketplace(payload.marketplace);
    const ext = String(payload.externalShipmentNumber || '').trim();
    if (!ext) {
      const err = new Error('Укажите номер отгрузки');
      err.statusCode = 400;
      throw err;
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
      const err = new Error('Добавьте хотя бы один товар в поставку');
      err.statusCode = 400;
      throw err;
    }

    let deductionWarehouseId = payload.deductionWarehouseId ?? null;
    if (deductionWarehouseId == null) {
      deductionWarehouseId = await resolveDefaultFboDeductionWarehouseId(pid);
    }

    const supplyId = await transaction(async (client) => {
      const dup = await client.query(
        `SELECT id FROM fbo_supplies
         WHERE ($1::bigint IS NULL OR profile_id = $1) AND marketplace = $2 AND external_shipment_number = $3`,
        [pid, mp, ext]
      );
      if (dup.rows?.length) {
        const err = new Error('Поставка с таким номером отгрузки уже загружена');
        err.statusCode = 409;
        err.code = 'DUPLICATE_SUPPLY';
        throw err;
      }

      const status = FBO_SUPPLY_STATUSES.includes(payload.status) ? payload.status : 'new';
      const ins = await client.query(
        `INSERT INTO fbo_supplies (
          profile_id, organization_id, created_by_user_id, status, marketplace,
          name, ready_at, marketplace_warehouse_name, marketplace_warehouse_id,
          placement_cluster, external_shipment_number, external_supply_id,
          deduction_warehouse_id, deduct_stock, source, note
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        RETURNING id`,
        [
          pid,
          payload.organizationId ?? null,
          userId ?? null,
          status,
          mp,
          payload.name ?? null,
          payload.readyAt ?? null,
          payload.marketplaceWarehouseName ?? null,
          payload.marketplaceWarehouseId ?? null,
          payload.placementCluster ?? payload.shippingCluster ?? null,
          ext,
          payload.externalSupplyId ?? null,
          deductionWarehouseId,
          payload.deductStock !== false,
          payload.source || 'manual',
          payload.note ?? null,
        ]
      );
      const newId = ins.rows[0].id;
      const lineRows = [];
      for (const it of items) {
        const qty = parseInt(it.quantity, 10);
        if (!qty || qty <= 0) continue;
        lineRows.push({ it, qty });
      }
      const ITEMS_INSERT_CHUNK = 50;
      for (let offset = 0; offset < lineRows.length; offset += ITEMS_INSERT_CHUNK) {
        const chunk = lineRows.slice(offset, offset + ITEMS_INSERT_CHUNK);
        const params = [newId];
        const tuples = chunk.map(({ it, qty }, idx) => {
          const base = idx * 10 + 2;
          return `($1,$${base},$${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9}::jsonb)`;
        });
        for (const { it, qty } of chunk) {
          params.push(
            it.productId ?? null,
            qty,
            qty,
            it.barcode ?? null,
            it.sku ?? null,
            it.mpOfferId ?? null,
            it.mpProductId ?? null,
            it.name ?? null,
            it.placementZone ?? it.placement_zone ?? null,
            JSON.stringify(it.ozonTags ?? it.ozon_tags ?? [])
          );
        }
        await client.query(
          `INSERT INTO fbo_supply_items (
            fbo_supply_id, product_id, quantity, mp_quantity, barcode, sku, mp_offer_id, mp_product_id, name,
            placement_zone, ozon_tags
          ) VALUES ${tuples.join(',')}`,
          params
        );
      }
      return newId;
    });

    if (!skipReserveRebalance && payload.deductStock !== false) {
      const runReserveRebalance = () =>
        fboSupplyReserveService.rebalanceReservesForSupply(supplyId, { profileId: pid }).catch((e) => {
          console.warn('[FboSupplies] reserve after create:', e?.message || e);
        });

      if (deferReserveRebalance) {
        setImmediate(runReserveRebalance);
      } else {
        await runReserveRebalance();
      }
    }

    if (lightReturn) {
      return {
        id: supplyId,
        marketplace: mp,
        externalShipmentNumber: ext,
        status: FBO_SUPPLY_STATUSES.includes(payload.status) ? payload.status : 'new',
        placementCluster: payload.placementCluster ?? payload.shippingCluster ?? null,
        organizationId: payload.organizationId ?? null,
        itemCount: items.reduce((s, it) => s + (parseInt(it.quantity, 10) || 0), 0),
        itemsLineCount: items.filter((it) => (parseInt(it.quantity, 10) || 0) > 0).length,
      };
    }

    const created = await this.getById(supplyId, { profileId: pid });
    if (created.status === 'shipped' && created.deductStock) {
      try {
        await this.applyStockDeductionIfNeeded(supplyId, { profileId: pid });
      } catch (e) {
        console.warn('[FboSupplies] create→shipped stock:', e?.message || e);
      }
      return this.getById(supplyId, { profileId: pid });
    }
    return created;
  }

  async update(id, payload, {
    profileId,
    deferReserveRebalance = false,
    skipMarketplaceSync = false,
    skipReserveEnrichment = false,
    lightReturn = false,
  } = {}) {
    const pid = normalizeProfileId(profileId);
    const statusOnly = isStatusOnlyUpdate(payload);
    const fastPath = statusOnly || lightReturn;
    const existing = await this.getById(id, {
      profileId: pid,
      skipReserveEnrichment: fastPath || skipReserveEnrichment,
      skipPackingEval: statusOnly,
    });
    const prevStatus = existing.status;
    const fields = [];
    const params = [id, pid];
    const setField = (col, val) => {
      params.push(val);
      fields.push(`${col} = $${params.length}`);
    };
    if (payload.marketplace !== undefined) setField('marketplace', normalizeMarketplace(payload.marketplace));
    if (payload.externalShipmentNumber !== undefined) {
      const ext = String(payload.externalShipmentNumber).trim();
      if (!ext) {
        const err = new Error('Укажите номер отгрузки');
        err.statusCode = 400;
        throw err;
      }
      const dup = await query(
        `SELECT id FROM fbo_supplies
         WHERE ($1::bigint IS NULL OR profile_id = $1) AND marketplace = $2
           AND external_shipment_number = $3 AND id <> $4`,
        [pid, normalizeMarketplace(payload.marketplace ?? existing.marketplace), ext, id]
      );
      if (dup.rows?.length) {
        const err = new Error('Поставка с таким номером отгрузки уже есть');
        err.statusCode = 409;
        throw err;
      }
      setField('external_shipment_number', ext);
    }
    if (payload.name !== undefined) setField('name', payload.name);
    if (payload.readyAt !== undefined) setField('ready_at', payload.readyAt);
    if (payload.marketplaceWarehouseName !== undefined) {
      setField('marketplace_warehouse_name', payload.marketplaceWarehouseName);
    }
    if (payload.marketplaceWarehouseId !== undefined) {
      setField('marketplace_warehouse_id', payload.marketplaceWarehouseId);
    }
    if (payload.placementCluster !== undefined) {
      const cluster =
        payload.placementCluster != null ? String(payload.placementCluster).trim() : '';
      setField('placement_cluster', cluster || null);
    }
    if (payload.deductionWarehouseId !== undefined) {
      setField('deduction_warehouse_id', payload.deductionWarehouseId);
    }
    if (payload.externalSupplyId !== undefined) {
      const sid =
        payload.externalSupplyId != null && String(payload.externalSupplyId).trim() !== ''
          ? String(payload.externalSupplyId).trim()
          : null;
      setField('external_supply_id', sid);
    }
    if (payload.organizationId !== undefined) setField('organization_id', payload.organizationId);
    if (payload.deductStock !== undefined) setField('deduct_stock', !!payload.deductStock);
    if (payload.note !== undefined) setField('note', payload.note);
    if (payload.status !== undefined && FBO_SUPPLY_STATUSES.includes(payload.status)) {
      if (payload.status === 'packed' || payload.status === 'ready_for_supply') {
        const packingEval = await evaluateSupplyPacking(id);
        if (payload.status === 'packed') assertCanSetPackedStatus(packingEval);
        else assertCanSetReadyForSupply(packingEval);
      }
      setField('status', payload.status);
    }
    if (!fields.length) return existing;

    const newStatus = payload.status !== undefined ? payload.status : existing.status;
    const willDeduct =
      prevStatus !== 'shipped' &&
      newStatus === 'shipped' &&
      (payload.deductStock !== undefined ? !!payload.deductStock : !!existing.deductStock);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    await query(
      `UPDATE fbo_supplies SET ${fields.join(', ')}
       WHERE id = $1 AND ($2::bigint IS NULL OR profile_id = $2)`,
      params
    );

    let result;
    const canLightReturn = (statusOnly || lightReturn) && !willDeduct;
    if (canLightReturn) {
      result = { ...existing, status: newStatus };
    } else {
      result = await this.getById(id, {
        profileId: pid,
        skipReserveEnrichment: statusOnly,
      });
    }
    if (willDeduct) {
      try {
        const stockResult = await this.applyStockDeductionIfNeeded(id, { profileId: pid });
        result = await this.getById(id, { profileId: pid });
        result.stockDeduction = stockResult;
      } catch (e) {
        await query(
          `UPDATE fbo_supplies SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [prevStatus, id]
        );
        throw e;
      }
    }

    // Терминальные статусы: всегда снимаем резерв (идемпотентно).
    // Раньше при willDeduct + already_deducted ветка release не выполнялась.
    if (FBO_RESERVE_TERMINAL_STATUSES.has(result.status)) {
      await fboSupplyReserveService.releaseReservesForSupply(id, { profileId: pid }).catch((e) => {
        console.warn('[FboSupplies] release on terminal:', e?.message || e);
      });
    } else if (result.deductStock) {
      const runRebalance = () =>
        fboSupplyReserveService
          .rebalanceReservesForSupply(id, { profileId: pid, skipMarketplaceSync: true })
          .catch((e) => {
            console.warn('[FboSupplies] reserve after update:', e?.message || e);
          });
      if (statusOnly || deferReserveRebalance) {
        setImmediate(runRebalance);
      } else {
        await runRebalance();
      }
    } else {
      await fboSupplyReserveService.releaseReservesForSupply(id, { profileId: pid }).catch((e) => {
        console.warn('[FboSupplies] release (deduct off):', e?.message || e);
      });
    }

    if (
      !skipMarketplaceSync &&
      !statusOnly &&
      ['ready_for_supply', 'shipped'].includes(result.status)
    ) {
      try {
        const { default: fboSuppliesImportService } = await import('./fboSuppliesImport.service.js');
        const sync = await fboSuppliesImportService.syncSupplyStatusFromMarketplace(id, { profileId: pid });
        if (sync?.updated && sync.supply) {
          result = sync.supply;
        }
      } catch (e) {
        console.warn('[FboSupplies] marketplace status sync:', e?.message || e);
      }
    }

    return result;
  }

  async advanceStatus(id, { profileId } = {}) {
    const supply = await this.getById(id, { profileId });
    const next = getNextFboSupplyStatus(supply.status);
    if (!next) {
      const err = new Error('Нельзя перейти к следующему статусу');
      err.statusCode = 400;
      throw err;
    }
    if (next === 'packed' || next === 'ready_for_supply') {
      const packingEval = await evaluateSupplyPacking(id);
      if (next === 'packed') assertCanSetPackedStatus(packingEval);
      else assertCanSetReadyForSupply(packingEval);
    }
    return this.update(id, { status: next }, {
      profileId,
      deferReserveRebalance: true,
      skipMarketplaceSync: true,
    });
  }

  /** После изменения сборки: при расхождениях — статус «Новая». */
  async syncStatusAfterPackingChange(supplyId) {
    return syncSupplyStatusForPacking(supplyId);
  }

  async _assertSupplyAccess(supplyId, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    const sid = parseInt(supplyId, 10);
    const r = await query(
      `SELECT id FROM fbo_supplies WHERE id = $1 AND ($2::bigint IS NULL OR profile_id = $2)`,
      [sid, pid]
    );
    if (!r.rows?.length) {
      const err = new Error('Поставка FBO не найдена');
      err.statusCode = 404;
      throw err;
    }
    return sid;
  }

  async _getSupplyMarketplace(supplyId) {
    const r = await query(`SELECT marketplace FROM fbo_supplies WHERE id = $1`, [supplyId]);
    return r.rows?.[0]?.marketplace ?? null;
  }

  async _loadProductForSupplyLine(productId, { profileId, marketplace } = {}) {
    const pid = normalizeProfileId(profileId);
    const pnum = parseInt(productId, 10);
    if (!Number.isFinite(pnum) || pnum < 1) {
      const err = new Error('Укажите товар');
      err.statusCode = 400;
      throw err;
    }
    const r = await query(
      `SELECT id, name, sku FROM products WHERE id = $1 AND ($2::bigint IS NULL OR profile_id = $2)`,
      [pnum, pid]
    );
    if (!r.rows?.length) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }
    const row = r.rows[0];
    let barcode = null;
    try {
      const bc = await query(
        `SELECT barcode, marketplaces FROM barcodes WHERE product_id = $1 ORDER BY id`,
        [pnum]
      );
      const rows = (bc.rows || []).map((r) => ({
        barcode: r.barcode,
        marketplaces: parseBarcodesMarketplacesColumn(r.marketplaces),
      }));
      barcode = pickBarcodeForMarketplace(rows, marketplace);
    } catch {
      /* optional */
    }
    return {
      id: Number(row.id),
      name: row.name,
      sku: row.sku,
      barcode,
    };
  }

  async addSupplyItem(supplyId, payload, { profileId } = {}) {
    const sid = await this._assertSupplyAccess(supplyId, { profileId });
    const marketplace = await this._getSupplyMarketplace(sid);
    const prod = await this._loadProductForSupplyLine(payload.productId, { profileId, marketplace });
    const qty = parseInt(payload.quantity, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      const err = new Error('Укажите количество больше 0');
      err.statusCode = 400;
      throw err;
    }
    const ins = await query(
      `INSERT INTO fbo_supply_items (
        fbo_supply_id, product_id, quantity, mp_quantity, barcode, sku, name
      ) VALUES ($1,$2,$3,$3,$4,$5,$6)
      RETURNING id, fbo_supply_id, product_id, quantity`,
      [sid, prod.id, qty, prod.barcode, prod.sku, prod.name]
    );
    await query(
      `UPDATE fbo_supplies
       SET pending_mp_content_update = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [sid]
    );
    const row = ins.rows[0];
    await fboSupplyReserveService
      .rebalanceReservesForProduct(prod.id, { profileId: normalizeProfileId(profileId) })
      .catch(() => {});
    return {
      id: row.id,
      supplyId: row.fbo_supply_id,
      productId: row.product_id,
      quantity: row.quantity,
    };
  }

  async replaceSupplyItemProduct(supplyId, itemId, payload, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    const sid = await this._assertSupplyAccess(supplyId, { profileId });
    const iid = parseInt(itemId, 10);
    const marketplace = await this._getSupplyMarketplace(sid);
    const prod = await this._loadProductForSupplyLine(payload.productId, { profileId, marketplace });
    const qty = parseInt(payload.quantity, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      const err = new Error('Укажите количество больше 0');
      err.statusCode = 400;
      throw err;
    }

    const belongs = await query(
      `SELECT si.id FROM fbo_supply_items si WHERE si.id = $1 AND si.fbo_supply_id = $2`,
      [iid, sid]
    );
    if (!belongs.rows?.length) {
      const err = new Error('Строка поставки не найдена');
      err.statusCode = 404;
      throw err;
    }

    const packed = await query(
      `SELECT 1 FROM fbo_supply_cargo_contents WHERE fbo_supply_item_id = $1 LIMIT 1`,
      [iid]
    );
    if (packed.rows?.length) {
      const err = new Error('Товар уже упакован в грузоместо — замените в карточке поставки');
      err.statusCode = 400;
      throw err;
    }

    const prevR = await query(`SELECT product_id FROM fbo_supply_items WHERE id = $1`, [iid]);
    const prevPid = prevR.rows?.[0]?.product_id;

    const r = await query(
      `UPDATE fbo_supply_items
       SET product_id = $1, sku = $2, name = $3, barcode = $4, quantity = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING id, fbo_supply_id, product_id, quantity`,
      [prod.id, prod.sku, prod.name, prod.barcode, qty, iid]
    );
    await fboSupplyReserveService.rebalanceReservesForSupply(sid, { profileId: pid }).catch(() => {});
    if (prevPid && Number(prevPid) !== Number(prod.id)) {
      await fboSupplyReserveService
        .rebalanceReservesForProduct(prevPid, { profileId: pid })
        .catch(() => {});
    }
    return {
      id: r.rows[0].id,
      supplyId: r.rows[0].fbo_supply_id,
      productId: r.rows[0].product_id,
      quantity: r.rows[0].quantity,
      replaced: true,
    };
  }

  async updateSupplyItemQuantity(supplyId, itemId, quantity, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    const sid = parseInt(supplyId, 10);
    const iid = parseInt(itemId, 10);
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 0) {
      const err = new Error('Укажите неотрицательное количество');
      err.statusCode = 400;
      throw err;
    }

    const belongs = await query(
      `SELECT si.id, si.product_id
       FROM fbo_supply_items si
       INNER JOIN fbo_supplies s ON s.id = si.fbo_supply_id
       WHERE si.id = $1 AND si.fbo_supply_id = $2
         AND ($3::bigint IS NULL OR s.profile_id = $3)`,
      [iid, sid, pid]
    );
    if (!belongs.rows?.length) {
      const err = new Error('Строка поставки не найдена');
      err.statusCode = 404;
      throw err;
    }
    const productId = belongs.rows[0].product_id;

    const markPendingMpContent = async () => {
      await query(
        `UPDATE fbo_supplies
         SET pending_mp_content_update = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [sid]
      );
    };

    if (qty === 0) {
      await query(`DELETE FROM fbo_supply_items WHERE id = $1`, [iid]);
      if (productId) {
        await fboSupplyReserveService
          .rebalanceReservesForProduct(productId, { profileId: pid })
          .catch(() => {});
      }
      await markPendingMpContent();
      const sync = await syncSupplyStatusForPacking(sid);
      return {
        id: iid,
        quantity: 0,
        deleted: true,
        pendingMpContentUpdate: true,
        supplyStatus: sync.status,
        packingAllMatch: sync.allMatch,
        statusReverted: sync.reverted,
      };
    }

    const r = await query(
      `UPDATE fbo_supply_items SET quantity = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, fbo_supply_id, quantity`,
      [qty, iid]
    );
    if (productId) {
      await fboSupplyReserveService
        .rebalanceReservesForProduct(productId, { profileId: pid })
        .catch(() => {});
    }
    await markPendingMpContent();
    const sync = await syncSupplyStatusForPacking(sid);
    return {
      id: r.rows[0].id,
      supplyId: r.rows[0].fbo_supply_id,
      quantity: r.rows[0].quantity,
      deleted: false,
      pendingMpContentUpdate: true,
      supplyStatus: sync.status,
      packingAllMatch: sync.allMatch,
      statusReverted: sync.reverted,
    };
  }

  async delete(id, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    const itemsR = await query(
      `SELECT si.id
       FROM fbo_supply_items si
       INNER JOIN fbo_supplies s ON s.id = si.fbo_supply_id
       WHERE si.fbo_supply_id = $1 AND ($2::bigint IS NULL OR s.profile_id = $2)`,
      [id, pid]
    );
    const itemIds = (itemsR.rows || []).map((row) => String(row.id));

    const r = await query(
      `DELETE FROM fbo_supplies WHERE id = $1 AND ($2::bigint IS NULL OR profile_id = $2) RETURNING id`,
      [id, pid]
    );
    if (!r.rows?.length) {
      const err = new Error('Поставка FBO не найдена');
      err.statusCode = 404;
      throw err;
    }

    if (itemIds.length) {
      const supplyId = Number(id);
      setImmediate(() => {
        fboSupplyReserveService
          .releaseReservesForSupplyItemIds(supplyId, itemIds, {
            profileId: pid,
            skipMarketplaceSync: true,
          })
          .catch((err) => {
            console.warn(
              `[FBO delete] reserve release failed for supply ${supplyId}:`,
              err?.message || err
            );
          });
      });
    }

    return { id: r.rows[0].id };
  }
}

export default new FboSuppliesService();
