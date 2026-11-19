/**
 * Возврат поставки FBO: приём коробок сканом, возврат остатков, реактивация без перепаковки.
 */

import { query } from '../config/database.js';
import {
  normalizeFboSupplyStatus,
  FBO_SUPPLY_STATUSES,
} from '../constants/fboSupplyStatuses.js';
import { evaluateSupplyPacking } from '../utils/fboSupplyPackingCheck.js';
import {
  decodeWbCargoBoxNumber,
  formatCargoBarcodeLabel,
  isWbCargoQrPayload,
} from '../utils/wbCargoQr.js';
import stockMovementsService from './stockMovements.service.js';
import fboSupplyReserveService from './fboSupplyReserve.service.js';
import fboSuppliesPackingService from './fboSuppliesPacking.service.js';
import fboSuppliesService from './fboSupplies.service.js';

const RETURN_ACCEPT_STATUSES = new Set(['shipped', 'closed', 'return']);
const LABEL_ASSIGN_STATUSES = new Set(['packing', 'ready_for_supply', 'return']);

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

function normalizeBarcode(v) {
  return v != null ? String(v).trim() : '';
}

function mapCargoUnit(row) {
  const barcode = row.barcode != null ? String(row.barcode) : '';
  return {
    id: Number(row.id),
    fboSupplyId: Number(row.fbo_supply_id),
    barcode,
    barcodeLabel: formatCargoBarcodeLabel(barcode),
    cargoKind: String(row.cargo_kind || 'box').toLowerCase() === 'pallet' ? 'pallet' : 'box',
    returnedAt: row.returned_at ?? null,
    createdAt: row.created_at ?? null,
    contents: [],
  };
}

async function assertSupplyAccess(supplyId, profileId) {
  const pid = normalizeProfileId(profileId);
  const r = await query(
    `SELECT id, profile_id, organization_id, marketplace, status,
            external_shipment_number, external_supply_id,
            deduction_warehouse_id, deduct_stock, stock_deducted_at
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
  const row = r.rows[0];
  return {
    id: Number(row.id),
    profileId: row.profile_id,
    organizationId: row.organization_id,
    marketplace: row.marketplace,
    status: normalizeFboSupplyStatus(row.status),
    externalShipmentNumber: row.external_shipment_number,
    externalSupplyId: row.external_supply_id,
    deductionWarehouseId:
      row.deduction_warehouse_id != null ? Number(row.deduction_warehouse_id) : null,
    deductStock: row.deduct_stock === true,
    stockDeductedAt: row.stock_deducted_at ?? null,
  };
}

/** Поиск грузоместа: точный ШК, затем короткий номер WB из QR. */
async function findCargoUnitByBarcode(supplyId, barcode) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;

  const exact = await query(
    `SELECT id, fbo_supply_id, barcode, cargo_kind, returned_at, created_at
     FROM fbo_supply_cargo_units
     WHERE fbo_supply_id = $1 AND barcode = $2
     LIMIT 1`,
    [supplyId, code]
  );
  if (exact.rows?.[0]) return exact.rows[0];

  const boxNo = isWbCargoQrPayload(code) ? decodeWbCargoBoxNumber(code) : code;
  if (boxNo && boxNo !== code) {
    const byExactBox = await query(
      `SELECT id, fbo_supply_id, barcode, cargo_kind, returned_at, created_at
       FROM fbo_supply_cargo_units
       WHERE fbo_supply_id = $1 AND barcode = $2
       LIMIT 1`,
      [supplyId, boxNo]
    );
    if (byExactBox.rows?.[0]) return byExactBox.rows[0];
  }

  const all = await query(
    `SELECT id, fbo_supply_id, barcode, cargo_kind, returned_at, created_at
     FROM fbo_supply_cargo_units
     WHERE fbo_supply_id = $1`,
    [supplyId]
  );
  const needle = boxNo || code;
  for (const row of all.rows || []) {
    const stored = String(row.barcode || '');
    if (formatCargoBarcodeLabel(stored) === needle) return row;
    if (isWbCargoQrPayload(stored) && decodeWbCargoBoxNumber(stored) === needle) return row;
  }
  return null;
}

async function loadCargoContents(cargoUnitId) {
  const r = await query(
    `SELECT cc.id, cc.fbo_supply_item_id, cc.quantity,
            i.product_id, i.sku, i.name, i.barcode AS item_barcode,
            p.name AS product_name
     FROM fbo_supply_cargo_contents cc
     JOIN fbo_supply_items i ON i.id = cc.fbo_supply_item_id
     LEFT JOIN products p ON p.id = i.product_id
     WHERE cc.cargo_unit_id = $1 AND cc.quantity > 0
     ORDER BY cc.id`,
    [cargoUnitId]
  );
  return (r.rows || []).map((row) => ({
    id: Number(row.id),
    supplyItemId: Number(row.fbo_supply_item_id),
    productId: row.product_id != null ? Number(row.product_id) : null,
    sku: row.sku,
    productName: row.product_name || row.name || null,
    barcode: row.item_barcode,
    quantity: Number(row.quantity) || 0,
  }));
}

async function alreadyRestoredLine(supplyId, cargoUnitId, supplyItemId) {
  const r = await query(
    `SELECT 1 FROM stock_movements
     WHERE type = 'receipt'
       AND meta->>'fbo_supply_return' = 'true'
       AND meta->>'fbo_supply_id' = $1
       AND meta->>'fbo_cargo_unit_id' = $2
       AND meta->>'fbo_supply_item_id' = $3
     LIMIT 1`,
    [String(supplyId), String(cargoUnitId), String(supplyItemId)]
  );
  return (r.rows?.length ?? 0) > 0;
}

/**
 * Вернуть на склад состав одной коробки (если ранее списывали при отгрузке).
 */
async function restoreStockForCargoUnit(supply, cargoUnitId, contents) {
  const whId = supply.deductionWarehouseId;
  if (!whId) {
    const err = new Error('Укажите склад списания остатков перед приёмом возврата');
    err.statusCode = 400;
    throw err;
  }

  const shouldRestore =
    supply.deductStock === true &&
    (supply.stockDeductedAt != null ||
      (await fboSuppliesService._alreadyDeductedStock(supply.id)));

  const restored = [];
  const skipped = [];
  if (!shouldRestore) {
    return { restored, skipped, stockRestored: false, reason: 'not_deducted' };
  }

  for (const line of contents) {
    const productId = Number(line.productId);
    const qty = Number(line.quantity) || 0;
    if (!productId || qty <= 0) {
      skipped.push({ supplyItemId: line.supplyItemId, reason: 'no_product' });
      continue;
    }
    if (await alreadyRestoredLine(supply.id, cargoUnitId, line.supplyItemId)) {
      skipped.push({ supplyItemId: line.supplyItemId, reason: 'already_restored' });
      continue;
    }
    await stockMovementsService.applyChange(productId, {
      delta: qty,
      type: 'receipt',
      reason: `FBO возврат поставки №${supply.id}: грузоместо ${cargoUnitId} (${supply.externalShipmentNumber})`,
      meta: {
        fbo_supply_id: String(supply.id),
        fbo_cargo_unit_id: String(cargoUnitId),
        fbo_supply_item_id: String(line.supplyItemId),
        fbo_supply_return: true,
        marketplace: supply.marketplace,
        external_shipment_number: supply.externalShipmentNumber,
        warehouse_id: whId,
        skip_marketplace_sync: true,
      },
    });
    restored.push({
      supplyItemId: line.supplyItemId,
      productId,
      quantity: qty,
    });
  }

  return { restored, skipped, stockRestored: restored.length > 0, reason: null };
}

class FboSuppliesReturnService {
  async getReturnState(supplyId, { profileId } = {}) {
    const supply = await assertSupplyAccess(supplyId, profileId);
    let cargoR;
    try {
      cargoR = await query(
        `SELECT id, fbo_supply_id, barcode, cargo_kind, returned_at, created_at
         FROM fbo_supply_cargo_units
         WHERE fbo_supply_id = $1
         ORDER BY id ASC`,
        [supplyId]
      );
    } catch (err) {
      if (/returned_at/i.test(String(err?.message || ''))) {
        cargoR = await query(
          `SELECT id, fbo_supply_id, barcode, cargo_kind, NULL::timestamptz AS returned_at, created_at
           FROM fbo_supply_cargo_units
           WHERE fbo_supply_id = $1
           ORDER BY id ASC`,
          [supplyId]
        );
      } else {
        throw err;
      }
    }

    const cargoUnits = [];
    for (const row of cargoR.rows || []) {
      const unit = mapCargoUnit(row);
      unit.contents = await loadCargoContents(unit.id);
      cargoUnits.push(unit);
    }

    const total = cargoUnits.length;
    const returnedCount = cargoUnits.filter((c) => c.returnedAt).length;

    return {
      supply: {
        id: supply.id,
        status: supply.status,
        marketplace: supply.marketplace,
        externalShipmentNumber: supply.externalShipmentNumber,
        externalSupplyId: supply.externalSupplyId,
        deductionWarehouseId: supply.deductionWarehouseId,
        deductStock: supply.deductStock,
        stockDeductedAt: supply.stockDeductedAt,
      },
      cargoUnits,
      progress: {
        total,
        returned: returnedCount,
        pending: Math.max(0, total - returnedCount),
        allReturned: total > 0 && returnedCount === total,
      },
    };
  }

  async scanReturnBox(supplyId, { barcode } = {}, { profileId } = {}) {
    const supply = await assertSupplyAccess(supplyId, profileId);
    if (!RETURN_ACCEPT_STATUSES.has(supply.status)) {
      const err = new Error(
        'Приём возврата доступен для поставок в статусе «Отгружен», «Закрыт» или «Возврат»'
      );
      err.statusCode = 400;
      throw err;
    }

    const code = normalizeBarcode(barcode);
    if (!code) {
      const err = new Error('Укажите штрихкод грузоместа');
      err.statusCode = 400;
      throw err;
    }

    const row = await findCargoUnitByBarcode(supplyId, code);
    if (!row) {
      const err = new Error('Грузоместо с таким штрихкодом не найдено в поставке');
      err.statusCode = 404;
      throw err;
    }

    if (row.returned_at) {
      const err = new Error(
        `Грузоместо ${formatCargoBarcodeLabel(row.barcode)} уже принято как возврат`
      );
      err.statusCode = 409;
      err.code = 'ALREADY_RETURNED';
      throw err;
    }

    const contents = await loadCargoContents(row.id);
    const stock = await restoreStockForCargoUnit(supply, row.id, contents);

    await query(
      `UPDATE fbo_supply_cargo_units
       SET returned_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND fbo_supply_id = $2 AND returned_at IS NULL`,
      [row.id, supplyId]
    );

    let supplyAfter = supply;
    if (supply.status !== 'return') {
      supplyAfter = await fboSuppliesService.update(
        supplyId,
        { status: 'return' },
        { profileId, lightReturn: true, skipMarketplaceSync: true }
      );
    }

    const state = await this.getReturnState(supplyId, { profileId });
    return {
      action: 'cargo_returned',
      message: `Принято грузоместо ${formatCargoBarcodeLabel(row.barcode)}${
        stock.stockRestored ? ', остатки возвращены на склад' : ''
      }`,
      cargoUnitId: Number(row.id),
      stock,
      supplyStatus: supplyAfter?.status || 'return',
      ...state,
    };
  }

  /**
   * Вернуть поставку в активные: новый номер, статус packing/ready, резерв, сброс списания.
   */
  async reactivateSupply(
    supplyId,
    { externalShipmentNumber, externalSupplyId } = {},
    { profileId } = {}
  ) {
    const supply = await assertSupplyAccess(supplyId, profileId);
    if (supply.status !== 'return') {
      const err = new Error('Реактивация доступна только для поставок в статусе «Возврат»');
      err.statusCode = 400;
      throw err;
    }

    const newNumber = normalizeBarcode(externalShipmentNumber);
    if (!newNumber) {
      const err = new Error('Укажите новый номер поставки');
      err.statusCode = 400;
      throw err;
    }

    const pid = normalizeProfileId(profileId) ?? supply.profileId;
    const dup = await query(
      `SELECT id FROM fbo_supplies
       WHERE ($1::bigint IS NULL OR profile_id = $1) AND marketplace = $2
         AND external_shipment_number = $3 AND id <> $4`,
      [pid, supply.marketplace, newNumber, supplyId]
    );
    if (dup.rows?.length) {
      const err = new Error('Поставка с таким номером отгрузки уже есть');
      err.statusCode = 409;
      throw err;
    }

    const packingEval = await evaluateSupplyPacking(supplyId);
    const nextStatus = packingEval.allMatch ? 'ready_for_supply' : 'packing';
    if (!FBO_SUPPLY_STATUSES.includes(nextStatus)) {
      const err = new Error('Некорректный целевой статус');
      err.statusCode = 400;
      throw err;
    }

    const fields = [
      'external_shipment_number = $3',
      'status = $4',
      'stock_deducted_at = NULL',
      'updated_at = CURRENT_TIMESTAMP',
    ];
    const params = [supplyId, pid, newNumber, nextStatus];
    let idx = 5;

    if (externalSupplyId !== undefined) {
      const sid =
        externalSupplyId != null && String(externalSupplyId).trim() !== ''
          ? String(externalSupplyId).trim()
          : null;
      fields.push(`external_supply_id = $${idx++}`);
      params.push(sid);
    }

    await query(
      `UPDATE fbo_supplies SET ${fields.join(', ')}
       WHERE id = $1 AND ($2::bigint IS NULL OR profile_id = $2)`,
      params
    );

    // Коробки снова в работе — снимаем отметку приёма возврата.
    await query(
      `UPDATE fbo_supply_cargo_units SET returned_at = NULL WHERE fbo_supply_id = $1`,
      [supplyId]
    );

    if (supply.deductStock) {
      try {
        await fboSupplyReserveService.rebalanceReservesForSupply(supplyId, {
          profileId: pid,
          skipMarketplaceSync: true,
        });
      } catch (e) {
        console.warn('[FboSuppliesReturn] reserve after reactivate:', e?.message || e);
      }
    }

    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId: pid });
    const updated = await fboSuppliesService.getById(supplyId, {
      profileId: pid,
      skipTerminalReserveRelease: true,
    });

    return {
      action: 'reactivated',
      message: `Поставка возвращена в активные (№ ${newNumber}, статус «${nextStatus}»)`,
      supply: updated,
      packing,
      supplyStatus: nextStatus,
    };
  }

  async assignCargoLabel(supplyId, { fromBarcode, toBarcode } = {}, { profileId } = {}) {
    const supply = await assertSupplyAccess(supplyId, profileId);
    if (!LABEL_ASSIGN_STATUSES.has(supply.status)) {
      const err = new Error(
        'Присвоение этикеток доступно в статусах «Возврат», «Упаковка» и «Готова к отгрузке»'
      );
      err.statusCode = 400;
      throw err;
    }

    const from = normalizeBarcode(fromBarcode);
    const to = normalizeBarcode(toBarcode);
    if (!from || !to) {
      const err = new Error('Отсканируйте текущую коробку и новую этикетку');
      err.statusCode = 400;
      throw err;
    }
    if (from === to) {
      const err = new Error('Новый штрихкод совпадает со старым');
      err.statusCode = 400;
      throw err;
    }

    const row = await findCargoUnitByBarcode(supplyId, from);
    if (!row) {
      const err = new Error('Грузоместо с таким штрихкодом не найдено');
      err.statusCode = 404;
      throw err;
    }

    const result = await fboSuppliesPackingService.updateCargoUnit(
      supplyId,
      row.id,
      { barcode: to },
      { profileId }
    );

    return {
      action: 'label_assigned',
      message: `Этикетка присвоена: ${formatCargoBarcodeLabel(from)} → ${formatCargoBarcodeLabel(to)}`,
      cargoUnitId: Number(row.id),
      fromBarcode: String(row.barcode || ''),
      toBarcode: to,
      packing: result.packing,
    };
  }
}

export default new FboSuppliesReturnService();
