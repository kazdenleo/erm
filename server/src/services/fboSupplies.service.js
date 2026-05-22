/**
 * Поставки FBO на склады маркетплейсов.
 */

import { query, transaction } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { FBO_SUPPLY_STATUSES, getNextFboSupplyStatus } from '../constants/fboSupplyStatuses.js';
import stockMovementsService from './stockMovements.service.js';

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
    externalShipmentNumber: row.external_shipment_number,
    externalSupplyId: row.external_supply_id,
    deductionWarehouseId: row.deduction_warehouse_id,
    deductionWarehouseName: row.deduction_warehouse_name ?? null,
    deductStock: row.deduct_stock,
    stockDeductedAt: row.stock_deducted_at ?? null,
    source: row.source,
    note: row.note,
    itemCount: row.item_count != null ? Number(row.item_count) : undefined,
    items: row.items,
  };
}

function mapItemRow(row) {
  return {
    id: row.id,
    fboSupplyId: row.fbo_supply_id,
    productId: row.product_id,
    quantity: row.quantity,
    barcode: row.barcode,
    sku: row.sku,
    mpOfferId: row.mp_offer_id,
    mpProductId: row.mp_product_id,
    name: row.name,
    productName: row.product_name ?? null,
    productImage: row.product_image ?? null,
  };
}

const SUPPLY_SELECT = `
  SELECT s.*,
         o.name AS organization_name,
         w.name AS deduction_warehouse_name,
         (SELECT COUNT(*)::int FROM fbo_supply_items i WHERE i.fbo_supply_id = s.id) AS item_count
  FROM fbo_supplies s
  LEFT JOIN organizations o ON o.id = s.organization_id
  LEFT JOIN warehouses w ON w.id = s.deduction_warehouse_id
`;

class FboSuppliesService {
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
      `SELECT i.*, p.name AS product_name,
              (SELECT elem->>'url' FROM jsonb_array_elements(COALESCE(p.images, '[]'::jsonb)) AS elem LIMIT 1) AS product_image
       FROM fbo_supply_items i
       LEFT JOIN products p ON p.id = i.product_id
       WHERE i.fbo_supply_id = $1
       ORDER BY i.id ASC`,
      [id]
    );
    supply.items = (itemsR.rows || []).map(mapItemRow);
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

    return transaction(async (client) => {
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
          external_shipment_number, external_supply_id, deduction_warehouse_id,
          deduct_stock, source, note
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
          ext,
          payload.externalSupplyId ?? null,
          payload.deductionWarehouseId ?? null,
          !!payload.deductStock,
          payload.source || 'manual',
          payload.note ?? null,
        ]
      );
      const supplyId = ins.rows[0].id;
      for (const it of items) {
        const qty = parseInt(it.quantity, 10);
        if (!qty || qty <= 0) continue;
        await client.query(
          `INSERT INTO fbo_supply_items (
            fbo_supply_id, product_id, quantity, barcode, sku, mp_offer_id, mp_product_id, name
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            supplyId,
            it.productId ?? null,
            qty,
            it.barcode ?? null,
            it.sku ?? null,
            it.mpOfferId ?? null,
            it.mpProductId ?? null,
            it.name ?? null,
          ]
        );
      }
      const created = await this.getById(supplyId, { profileId: pid });
      if (created.status === 'shipped' && created.deductStock) {
        try {
          await this.applyStockDeductionIfNeeded(supplyId, { profileId: pid });
        } catch (e) {
          console.warn('[FboSupplies] create→shipped stock:', e?.message || e);
        }
      }
      return this.getById(supplyId, { profileId: pid });
    });
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
    if (payload.name !== undefined) setField('name', payload.name);
    if (payload.readyAt !== undefined) setField('ready_at', payload.readyAt);
    if (payload.marketplaceWarehouseName !== undefined) {
      setField('marketplace_warehouse_name', payload.marketplaceWarehouseName);
    }
    if (payload.marketplaceWarehouseId !== undefined) {
      setField('marketplace_warehouse_id', payload.marketplaceWarehouseId);
    }
    if (payload.deductionWarehouseId !== undefined) {
      setField('deduction_warehouse_id', payload.deductionWarehouseId);
    }
    if (payload.organizationId !== undefined) setField('organization_id', payload.organizationId);
    if (payload.deductStock !== undefined) setField('deduct_stock', !!payload.deductStock);
    if (payload.note !== undefined) setField('note', payload.note);
    if (payload.status !== undefined && FBO_SUPPLY_STATUSES.includes(payload.status)) {
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
    return this.update(id, { status: next }, { profileId });
  }

  async delete(id, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
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
