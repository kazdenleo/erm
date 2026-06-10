/**
 * Поставки FBO на склады маркетплейсов.
 */

import { query, transaction } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { FBO_SUPPLY_STATUSES, getNextFboSupplyStatus } from '../constants/fboSupplyStatuses.js';
import stockMovementsService from './stockMovements.service.js';
import fboSupplyReserveService from './fboSupplyReserve.service.js';
import {
  assertCanSetReadyForSupply,
  evaluateSupplyPacking,
  syncSupplyStatusForPacking,
} from '../utils/fboSupplyPackingCheck.js';
import {
  pickBarcodeForMarketplace,
  parseBarcodesMarketplacesColumn,
} from '../utils/productBarcodes.js';

const FBO_RESERVE_TERMINAL_STATUSES = new Set(['shipped', 'closed', 'return']);

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
    itemCount: row.items_quantity_total != null ? Number(row.items_quantity_total) : undefined,
    itemsLineCount: row.items_line_count != null ? Number(row.items_line_count) : undefined,
    items: row.items,
  };
}

function mapItemRow(row) {
  return {
    id: row.id,
    fboSupplyId: row.fbo_supply_id,
    productId: row.product_id,
    quantity: row.quantity,
    reservedQuantity:
      row.reserved_quantity != null ? Number(row.reserved_quantity) : row.reservedQuantity ?? undefined,
    barcode: row.barcode,
    sku: row.sku,
    mpOfferId: row.mp_offer_id,
    mpProductId: row.mp_product_id,
    name: row.name,
    productName: row.product_name ?? null,
    productImage: row.product_image ?? null,
    productCategoryId: row.product_category_id ?? null,
    placementZone: row.placement_zone ?? null,
    ozonTags: Array.isArray(row.ozon_tags) ? row.ozon_tags : [],
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
    if (await this._alreadyDeductedStock(supplyId)) {
      return { applied: false, reason: 'already_deducted', stockDeductedAt: supply.stockDeductedAt };
    }
    if (!supply.deductionWarehouseId) {
      const err = new Error('Укажите склад списания остатков перед отгрузкой');
      err.statusCode = 400;
      throw err;
    }

    await fboSupplyReserveService.releaseReservesForSupply(supplyId, { profileId });

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

  async list({ profileId, limit = 200, status = null, marketplace = null } = {}) {
    const pid = normalizeProfileId(profileId);
    const params = [pid];
    let sql = `${SUPPLY_SELECT} WHERE ($1::bigint IS NULL OR s.profile_id = $1)`;
    if (status) {
      params.push(status);
      sql += ` AND s.status = $${params.length}`;
    }
    if (marketplace) {
      params.push(normalizeMarketplace(marketplace));
      sql += ` AND s.marketplace = $${params.length}`;
    }
    params.push(Math.min(500, Math.max(1, parseInt(limit, 10) || 200)));
    sql += ` ORDER BY s.created_at DESC LIMIT $${params.length}`;
    const r = await query(sql, params);
    return (r.rows || []).map(mapSupplyRow);
  }

  async getById(id, { profileId } = {}) {
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
    const itemsR = await query(
      `SELECT i.*, p.name AS product_name, p.user_category_id AS product_category_id,
              (SELECT elem->>'url' FROM jsonb_array_elements(COALESCE(p.images, '[]'::jsonb)) AS elem LIMIT 1) AS product_image
       FROM fbo_supply_items i
       LEFT JOIN products p ON p.id = i.product_id
       WHERE i.fbo_supply_id = $1
       ORDER BY i.id ASC`,
      [id]
    );
    supply.items = await fboSupplyReserveService.enrichItemsWithReserved(
      (itemsR.rows || []).map(mapItemRow)
    );
    const packingEval = await evaluateSupplyPacking(id);
    supply.packingAllMatch = packingEval.allMatch;
    supply.hasPackingDiscrepancy = packingEval.hasItems && !packingEval.allMatch;
    supply.packingDiscrepancies = packingEval.discrepancies;
    return supply;
  }

  async create(payload, { profileId, userId } = {}) {
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
          payload.deductionWarehouseId ?? null,
          !!payload.deductStock,
          payload.source || 'manual',
          payload.note ?? null,
        ]
      );
      const newId = ins.rows[0].id;
      for (const it of items) {
        const qty = parseInt(it.quantity, 10);
        if (!qty || qty <= 0) continue;
        const ozonTags = Array.isArray(it.ozonTags) ? JSON.stringify(it.ozonTags) : '[]';
        await client.query(
          `INSERT INTO fbo_supply_items (
            fbo_supply_id, product_id, quantity, barcode, sku, mp_offer_id, mp_product_id, name,
            placement_zone, ozon_tags
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [
            newId,
            it.productId ?? null,
            qty,
            it.barcode ?? null,
            it.sku ?? null,
            it.mpOfferId ?? null,
            it.mpProductId ?? null,
            it.name ?? null,
            it.placementZone ?? null,
            ozonTags,
          ]
        );
      }
      return newId;
    });

    await fboSupplyReserveService.rebalanceReservesForSupply(supplyId, { profileId: pid }).catch((e) => {
      console.warn('[FboSupplies] reserve after create:', e?.message || e);
    });

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

  async update(id, payload, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    const existing = await this.getById(id, { profileId: pid });
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
    if (payload.organizationId !== undefined) setField('organization_id', payload.organizationId);
    if (payload.deductStock !== undefined) setField('deduct_stock', !!payload.deductStock);
    if (payload.note !== undefined) setField('note', payload.note);
    if (payload.status !== undefined && FBO_SUPPLY_STATUSES.includes(payload.status)) {
      if (payload.status === 'ready_for_supply') {
        assertCanSetReadyForSupply(await evaluateSupplyPacking(id));
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

    let result = await this.getById(id, { profileId: pid });
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
    } else if (FBO_RESERVE_TERMINAL_STATUSES.has(result.status)) {
      await fboSupplyReserveService.releaseReservesForSupply(id, { profileId: pid }).catch(() => {});
    } else {
      await fboSupplyReserveService.rebalanceReservesForSupply(id, { profileId: pid }).catch((e) => {
        console.warn('[FboSupplies] reserve after update:', e?.message || e);
      });
    }
    return this.getById(id, { profileId: pid });
  }

  async advanceStatus(id, { profileId } = {}) {
    const supply = await this.getById(id, { profileId });
    const next = getNextFboSupplyStatus(supply.status);
    if (!next) {
      const err = new Error('Нельзя перейти к следующему статусу');
      err.statusCode = 400;
      throw err;
    }
    if (next === 'ready_for_supply') {
      assertCanSetReadyForSupply(await evaluateSupplyPacking(id));
    }
    return this.update(id, { status: next }, { profileId });
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
        fbo_supply_id, product_id, quantity, barcode, sku, name
      ) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, fbo_supply_id, product_id, quantity`,
      [sid, prod.id, qty, prod.barcode, prod.sku, prod.name]
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

    if (qty === 0) {
      await fboSupplyReserveService.releaseReservesForSupply(sid, { profileId: pid }).catch(() => {});
      await query(`DELETE FROM fbo_supply_items WHERE id = $1`, [iid]);
      if (productId) {
        await fboSupplyReserveService
          .rebalanceReservesForProduct(productId, { profileId: pid })
          .catch(() => {});
      }
      return { id: iid, quantity: 0, deleted: true };
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
    return {
      id: r.rows[0].id,
      supplyId: r.rows[0].fbo_supply_id,
      quantity: r.rows[0].quantity,
      deleted: false,
    };
  }

  async delete(id, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    await fboSupplyReserveService.releaseReservesForSupply(id, { profileId: pid }).catch(() => {});
    const r = await query(
      `DELETE FROM fbo_supplies WHERE id = $1 AND ($2::bigint IS NULL OR profile_id = $2) RETURNING id`,
      [id, pid]
    );
    if (!r.rows?.length) {
      const err = new Error('Поставка FBO не найдена');
      err.statusCode = 404;
      throw err;
    }
    return { id: r.rows[0].id };
  }
}

export default new FboSuppliesService();
