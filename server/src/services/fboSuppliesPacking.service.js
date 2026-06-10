/**
 * Сборка поставки FBO: грузоместа и сканирование товаров.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import fboSuppliesService from './fboSupplies.service.js';
import { syncSupplyStatusForPacking } from '../utils/fboSupplyPackingCheck.js';
import {
  buildWeightExceededMessage,
  enrichCargoWeightLimits,
  loadFboWeightLimitsForSupply,
  parsePalletTareWeightKg,
} from '../utils/fboPackingLimits.js';

function normalizeBarcode(v) {
  return v != null ? String(v).trim() : '';
}

/** Объём единицы товара, л (из карточки или габаритов мм). */
function productUnitVolumeLiters(row) {
  const vol = row.product_volume != null ? Number(row.product_volume) : NaN;
  if (Number.isFinite(vol) && vol > 0) return vol;
  const l = Number(row.product_length) || 0;
  const w = Number(row.product_width) || 0;
  const h = Number(row.product_height) || 0;
  if (l > 0 && w > 0 && h > 0) return (l * w * h) / 1_000_000;
  return 0;
}

function productUnitWeightGrams(row) {
  const w = Number(row.product_weight);
  return Number.isFinite(w) && w > 0 ? w : 0;
}

function mapContentLine(row) {
  const qty = Number(row.quantity);
  const unitVolumeL = productUnitVolumeLiters(row);
  const unitWeightG = productUnitWeightGrams(row);
  return {
    id: row.id,
    supplyItemId: row.fbo_supply_item_id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    barcode: row.item_barcode,
    quantity: qty,
    plannedQuantity: Number(row.planned_qty),
    placementZone: row.placement_zone ?? null,
    expiresAt: row.expires_at ?? null,
    unitVolumeL,
    unitWeightG,
    lineVolumeL: unitVolumeL * qty,
    lineWeightG: unitWeightG * qty,
  };
}

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

async function assertSupplyAccess(supplyId, profileId) {
  const supply = await fboSuppliesService.getById(supplyId, { profileId });
  return supply;
}

async function resolveProductIdByBarcode(barcode, profileId) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;
  const pid = normalizeProfileId(profileId);

  if (repositoryFactory.isUsingPostgreSQL()) {
    const repo = repositoryFactory.getProductsRepository();
    if (typeof repo?.findByBarcode === 'function') {
      const product = await repo.findByBarcode(code);
      if (product?.id != null) {
        if (pid != null && product.profile_id != null && Number(product.profile_id) !== pid) {
          return null;
        }
        return Number(product.id);
      }
    }
  }

  const r = await query(
    `SELECT p.id
     FROM products p
     WHERE ($1::bigint IS NULL OR p.profile_id = $1)
       AND (
         EXISTS (
           SELECT 1 FROM barcodes b
           WHERE b.product_id = p.id AND TRIM(b.barcode) = $2
         )
         OR TRIM(COALESCE(p.sku, '')) = $2
         OR EXISTS (
           SELECT 1 FROM product_skus ps
           WHERE ps.product_id = p.id AND TRIM(ps.sku) = $2
         )
       )
     LIMIT 1`,
    [pid, code]
  );
  return r.rows?.[0]?.id != null ? Number(r.rows[0].id) : null;
}

async function findSupplyItemForScan(supplyId, barcode, profileId) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;
  const itemsR = await query(
    `SELECT i.id, i.product_id, i.quantity, i.barcode, i.sku, i.name,
            p.name AS product_name
     FROM fbo_supply_items i
     LEFT JOIN products p ON p.id = i.product_id
     WHERE i.fbo_supply_id = $1`,
    [supplyId]
  );
  const items = itemsR.rows || [];
  for (const row of items) {
    if (row.barcode && normalizeBarcode(row.barcode) === code) return row;
    if (row.sku && normalizeBarcode(row.sku) === code) return row;
  }
  const productId = await resolveProductIdByBarcode(code, profileId);
  if (productId != null) {
    const match = items.find((row) => row.product_id != null && Number(row.product_id) === productId);
    if (match) return match;
  }
  return null;
}

function normalizeCargoKind(v) {
  return String(v || '').trim().toLowerCase() === 'pallet' ? 'pallet' : 'box';
}

function mapCargoRow(row) {
  const kind = normalizeCargoKind(row.cargo_kind);
  const palletTareWeightKg =
    kind === 'pallet' && row.pallet_tare_weight_kg != null
      ? parsePalletTareWeightKg(row.pallet_tare_weight_kg)
      : null;
  return {
    id: row.id,
    fboSupplyId: row.fbo_supply_id,
    barcode: row.barcode,
    cargoKind: kind,
    palletTareWeightKg,
    createdAt: row.created_at,
  };
}

async function withPackingStatusSync(supplyId, packing) {
  const sync = await syncSupplyStatusForPacking(supplyId);
  return {
    packing,
    supplyStatus: sync.status,
    packingAllMatch: sync.allMatch,
    statusReverted: sync.reverted,
  };
}

class FboSuppliesPackingService {
  async getPackingState(supplyId, { profileId } = {}) {
    const supply = await assertSupplyAccess(supplyId, profileId);
    const weightLimits = await loadFboWeightLimitsForSupply(supply, { profileId });

    const cargoR = await query(
      `SELECT c.id, c.fbo_supply_id, c.barcode, c.cargo_kind, c.pallet_tare_weight_kg, c.created_at
       FROM fbo_supply_cargo_units c
       WHERE c.fbo_supply_id = $1
       ORDER BY c.id ASC`,
      [supplyId]
    );

    const contentsR = await query(
      `SELECT cc.id, cc.cargo_unit_id, cc.fbo_supply_item_id, cc.quantity,
              cc.placement_zone, cc.expires_at,
              i.product_id, i.sku, i.barcode AS item_barcode, i.quantity AS planned_qty,
              COALESCE(p.name, i.name) AS product_name,
              p.weight AS product_weight,
              p.volume AS product_volume,
              p.length AS product_length,
              p.width AS product_width,
              p.height AS product_height
       FROM fbo_supply_cargo_contents cc
       JOIN fbo_supply_cargo_units cu ON cu.id = cc.cargo_unit_id
       JOIN fbo_supply_items i ON i.id = cc.fbo_supply_item_id
       LEFT JOIN products p ON p.id = i.product_id
       WHERE cu.fbo_supply_id = $1
       ORDER BY cc.cargo_unit_id, cc.id`,
      [supplyId]
    );

    const itemsR = await query(
      `SELECT i.id, i.quantity, i.product_id, i.sku, i.barcode,
              COALESCE(p.name, i.name) AS product_name
       FROM fbo_supply_items i
       LEFT JOIN products p ON p.id = i.product_id
       WHERE i.fbo_supply_id = $1
       ORDER BY i.id`,
      [supplyId]
    );

    const contentsByCargo = new Map();
    for (const row of contentsR.rows || []) {
      const cid = row.cargo_unit_id;
      if (!contentsByCargo.has(cid)) contentsByCargo.set(cid, []);
      contentsByCargo.get(cid).push(mapContentLine(row));
    }

    const packedByItem = new Map();
    const byCargoForItem = new Map();
    for (const row of contentsR.rows || []) {
      const itemId = row.fbo_supply_item_id;
      const qty = Number(row.quantity);
      packedByItem.set(itemId, (packedByItem.get(itemId) || 0) + qty);
      if (!byCargoForItem.has(itemId)) byCargoForItem.set(itemId, []);
      byCargoForItem.get(itemId).push({
        cargoUnitId: row.cargo_unit_id,
        quantity: qty,
      });
    }

    const cargoUnits = (cargoR.rows || []).map((row) => {
      const cargo = mapCargoRow(row);
      const contents = contentsByCargo.get(row.id) || [];
      cargo.contents = contents;
      cargo.totalQuantity = contents.reduce((s, c) => s + c.quantity, 0);
      cargo.totalVolumeL = contents.reduce((s, c) => s + (c.lineVolumeL || 0), 0);
      cargo.goodsWeightG = contents.reduce((s, c) => s + (c.lineWeightG || 0), 0);
      return enrichCargoWeightLimits(cargo, weightLimits);
    });

    const cargoBarcodeById = new Map(cargoUnits.map((c) => [c.id, c.barcode]));

    const itemStats = (itemsR.rows || []).map((row) => {
      const supplyItemId = row.id;
      const planned = Number(row.quantity);
      const packed = packedByItem.get(supplyItemId) || 0;
      const rawByCargo = byCargoForItem.get(supplyItemId) || [];
      const byCargo = rawByCargo.map((x) => ({
        cargoUnitId: x.cargoUnitId,
        cargoBarcode: cargoBarcodeById.get(x.cargoUnitId) || '',
        quantity: x.quantity,
      }));
      return {
        supplyItemId,
        productId: row.product_id,
        productName: row.product_name,
        sku: row.sku,
        barcode: row.barcode,
        planned,
        packed,
        discrepancy: packed - planned,
        byCargo,
      };
    });

    return { cargoUnits, itemStats, weightLimits };
  }

  async updateCargoUnit(supplyId, cargoUnitId, patch = {}, { profileId } = {}) {
    await assertSupplyAccess(supplyId, profileId);
    const cid = Number(cargoUnitId);
    if (!Number.isFinite(cid)) {
      const err = new Error('Некорректное грузоместо');
      err.statusCode = 400;
      throw err;
    }

    const fields = [];
    const params = [];
    let idx = 1;

    if (patch.cargoKind !== undefined) {
      const kind = normalizeCargoKind(patch.cargoKind);
      fields.push(`cargo_kind = $${idx++}`);
      params.push(kind);
      if (kind === 'box') {
        fields.push('pallet_tare_weight_kg = NULL');
      }
    }

    if (patch.palletTareWeightKg !== undefined) {
      const parsed = parsePalletTareWeightKg(patch.palletTareWeightKg);
      if (patch.palletTareWeightKg != null && String(patch.palletTareWeightKg).trim() !== '' && parsed == null) {
        const err = new Error('Вес паллеты: укажите неотрицательное число');
        err.statusCode = 400;
        throw err;
      }
      fields.push(`pallet_tare_weight_kg = $${idx++}`);
      params.push(parsed);
    }

    if (!fields.length) {
      const packing = await this.getPackingState(supplyId, { profileId });
      return { packing };
    }

    params.push(cid, supplyId);
    const r = await query(
      `UPDATE fbo_supply_cargo_units
       SET ${fields.join(', ')}
       WHERE id = $${idx++} AND fbo_supply_id = $${idx}
       RETURNING id`,
      params
    );
    if (!r.rows?.length) {
      const err = new Error('Грузоместо не найдено');
      err.statusCode = 404;
      throw err;
    }

    const packing = await this.getPackingState(supplyId, { profileId });
    return { packing };
  }

  async scan(supplyId, { barcode, activeCargoUnitId } = {}, { profileId } = {}) {
    const supply = await assertSupplyAccess(supplyId, profileId);
    const code = normalizeBarcode(barcode);
    if (!code) {
      const err = new Error('Укажите штрихкод');
      err.statusCode = 400;
      throw err;
    }

    const existingCargoR = await query(
      `SELECT id, fbo_supply_id, barcode, created_at
       FROM fbo_supply_cargo_units
       WHERE fbo_supply_id = $1 AND barcode = $2
       LIMIT 1`,
      [supplyId, code]
    );

    if (existingCargoR.rows?.length) {
      const cargo = mapCargoRow(existingCargoR.rows[0]);
      const packing = await this.getPackingState(supplyId, { profileId });
      return {
        action: 'cargo_selected',
        message: `Грузоместо: ${cargo.barcode}`,
        activeCargoUnitId: cargo.id,
        cargoUnit: cargo,
        packing,
      };
    }

    const activeId = activeCargoUnitId != null ? Number(activeCargoUnitId) : null;

    if (activeId) {
      const supplyItem = await findSupplyItemForScan(supplyId, code, profileId);
      if (!supplyItem) {
        const err = new Error('Товар не найден в этой поставке (штрихкод, артикул или SKU)');
        err.statusCode = 400;
        throw err;
      }

      const cargoCheck = await query(
        `SELECT id FROM fbo_supply_cargo_units WHERE id = $1 AND fbo_supply_id = $2`,
        [activeId, supplyId]
      );
      if (!cargoCheck.rows?.length) {
        const err = new Error('Активное грузоместо не найдено — отсканируйте коробку');
        err.statusCode = 400;
        throw err;
      }

      const upsert = await query(
        `INSERT INTO fbo_supply_cargo_contents (cargo_unit_id, fbo_supply_item_id, quantity)
         VALUES ($1, $2, 1)
         ON CONFLICT (cargo_unit_id, fbo_supply_item_id)
         DO UPDATE SET
           quantity = fbo_supply_cargo_contents.quantity + 1,
           updated_at = CURRENT_TIMESTAMP
         RETURNING quantity`,
        [activeId, supplyItem.id]
      );
      const newQty = Number(upsert.rows[0]?.quantity ?? 1);
      const packing = await this.getPackingState(supplyId, { profileId });
      const name = supplyItem.product_name || supplyItem.name || supplyItem.sku || 'товар';
      const syncMeta = await withPackingStatusSync(supplyId, packing);
      const activeCargo = (packing.cargoUnits || []).find((c) => Number(c.id) === activeId);
      const weightWarning = buildWeightExceededMessage(activeCargo);
      let message = `${name}: ${newQty} шт. в грузоместе`;
      if (weightWarning) message += `. ${weightWarning}`;
      return {
        action: 'product_added',
        message,
        weightWarning,
        activeCargoUnitId: activeId,
        supplyItemId: supplyItem.id,
        quantityInCargo: newQty,
        ...syncMeta,
      };
    }

    const ins = await query(
      `INSERT INTO fbo_supply_cargo_units (fbo_supply_id, barcode)
       VALUES ($1, $2)
       RETURNING id, fbo_supply_id, barcode, created_at`,
      [supplyId, code]
    );
    const cargo = mapCargoRow(ins.rows[0]);
    const packing = await this.getPackingState(supplyId, { profileId });
    return {
      action: 'cargo_created',
      message: `Добавлено грузоместо: ${cargo.barcode}`,
      activeCargoUnitId: cargo.id,
      cargoUnit: cargo,
      packing,
    };
  }

  /**
   * Снять 1 шт. товара из активного грузоместа по скану штрихкода.
   */
  async scanRemove(supplyId, { barcode, activeCargoUnitId } = {}, { profileId } = {}) {
    await assertSupplyAccess(supplyId, profileId);
    const code = normalizeBarcode(barcode);
    if (!code) {
      const err = new Error('Укажите штрихкод');
      err.statusCode = 400;
      throw err;
    }

    const activeId = activeCargoUnitId != null ? Number(activeCargoUnitId) : null;
    if (!activeId) {
      const err = new Error('Сначала выберите или отсканируйте грузоместо');
      err.statusCode = 400;
      throw err;
    }

    const cargoCheck = await query(
      `SELECT id, barcode FROM fbo_supply_cargo_units WHERE id = $1 AND fbo_supply_id = $2`,
      [activeId, supplyId]
    );
    if (!cargoCheck.rows?.length) {
      const err = new Error('Активное грузоместо не найдено');
      err.statusCode = 400;
      throw err;
    }

    const supplyItem = await findSupplyItemForScan(supplyId, code, profileId);
    if (!supplyItem) {
      const err = new Error('Товар не найден в этой поставке (штрихкод, артикул или SKU)');
      err.statusCode = 400;
      throw err;
    }

    const contentR = await query(
      `SELECT cc.id, cc.quantity
       FROM fbo_supply_cargo_contents cc
       WHERE cc.cargo_unit_id = $1 AND cc.fbo_supply_item_id = $2`,
      [activeId, supplyItem.id]
    );
    if (!contentR.rows?.length) {
      const err = new Error('Этого товара нет в активном грузоместе');
      err.statusCode = 400;
      throw err;
    }

    const row = contentR.rows[0];
    const prevQty = Number(row.quantity);
    if (prevQty <= 1) {
      await query(`DELETE FROM fbo_supply_cargo_contents WHERE id = $1`, [row.id]);
    } else {
      await query(
        `UPDATE fbo_supply_cargo_contents
         SET quantity = quantity - 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id]
      );
    }

    const packing = await this.getPackingState(supplyId, { profileId });
    const name = supplyItem.product_name || supplyItem.name || supplyItem.sku || 'товар';
    const newQty = Math.max(0, prevQty - 1);
    const syncMeta = await withPackingStatusSync(supplyId, packing);
    return {
      action: 'product_removed',
      message: `${name}: −1 шт. из грузоместа ${cargoCheck.rows[0].barcode} (осталось ${newQty})`,
      activeCargoUnitId: activeId,
      supplyItemId: supplyItem.id,
      quantityInCargo: newQty,
      ...syncMeta,
    };
  }

  async getPackingExportRows(supplyId, { profileId } = {}) {
    const supply = await assertSupplyAccess(supplyId, profileId);
    const r = await query(
      `SELECT cc.id, cc.quantity, cc.placement_zone, cc.expires_at,
              cu.barcode AS cargo_barcode,
              TRIM(COALESCE(i.sku, p.sku, '')) AS article,
              TRIM(COALESCE(
                i.barcode,
                (SELECT b.barcode FROM barcodes b WHERE b.product_id = p.id ORDER BY b.id LIMIT 1),
                ''
              )) AS product_barcode
       FROM fbo_supply_cargo_contents cc
       JOIN fbo_supply_cargo_units cu ON cu.id = cc.cargo_unit_id
       JOIN fbo_supply_items i ON i.id = cc.fbo_supply_item_id
       LEFT JOIN products p ON p.id = i.product_id
       WHERE cu.fbo_supply_id = $1
       ORDER BY cu.id ASC, cc.id ASC`,
      [supplyId]
    );
    return {
      marketplace: supply.marketplace,
      rows: (r.rows || []).map((row) => ({
        id: row.id,
        quantity: Number(row.quantity),
        placementZone: row.placement_zone != null ? String(row.placement_zone).trim() : '',
        expiresAt: row.expires_at,
        cargoBarcode: row.cargo_barcode,
        article: row.article,
        productBarcode: row.product_barcode,
      })),
    };
  }

  async updateCargoContent(supplyId, contentId, patch = {}, { profileId } = {}) {
    await assertSupplyAccess(supplyId, profileId);
    const cid = Number(contentId);
    if (!Number.isFinite(cid)) {
      const err = new Error('Некорректная строка состава');
      err.statusCode = 400;
      throw err;
    }

    const check = await query(
      `SELECT cc.id
       FROM fbo_supply_cargo_contents cc
       JOIN fbo_supply_cargo_units cu ON cu.id = cc.cargo_unit_id
       WHERE cc.id = $1 AND cu.fbo_supply_id = $2`,
      [cid, supplyId]
    );
    if (!check.rows?.length) {
      const err = new Error('Строка состава не найдена');
      err.statusCode = 404;
      throw err;
    }

    const fields = [];
    const params = [cid];
    let idx = 2;

    if (patch.placementZone !== undefined) {
      const z = patch.placementZone != null ? String(patch.placementZone).trim() : '';
      fields.push(`placement_zone = $${idx}`);
      params.push(z || null);
      idx += 1;
    }
    if (patch.expiresAt !== undefined) {
      const raw = patch.expiresAt;
      let dateVal = null;
      if (raw != null && String(raw).trim() !== '') {
        const s = String(raw).trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          const err = new Error('Срок годности: формат YYYY-MM-DD');
          err.statusCode = 400;
          throw err;
        }
        dateVal = s;
      }
      fields.push(`expires_at = $${idx}`);
      params.push(dateVal);
      idx += 1;
    }

    if (!fields.length) {
      const packing = await this.getPackingState(supplyId, { profileId });
      return { packing };
    }

    await query(
      `UPDATE fbo_supply_cargo_contents
       SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      params
    );

    const packing = await this.getPackingState(supplyId, { profileId });
    return { packing };
  }

  async deleteCargoUnit(supplyId, cargoUnitId, { profileId } = {}) {
    await assertSupplyAccess(supplyId, profileId);
    const r = await query(
      `DELETE FROM fbo_supply_cargo_units
       WHERE id = $1 AND fbo_supply_id = $2
       RETURNING id`,
      [cargoUnitId, supplyId]
    );
    if (!r.rows?.length) {
      const err = new Error('Грузоместо не найдено');
      err.statusCode = 404;
      throw err;
    }
    const packing = await this.getPackingState(supplyId, { profileId });
    return withPackingStatusSync(supplyId, packing);
  }
}

export default new FboSuppliesPackingService();
