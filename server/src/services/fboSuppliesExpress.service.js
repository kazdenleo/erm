/**
 * Экспресс FBO: скан ГМ → скан товара = приёмка(1 с «в пути») + сборка + упаковка + этикетка.
 */

import { query } from '../config/database.js';
import fboSuppliesCollectService, {
  resolveScanToSupplyItem,
} from './fboSuppliesCollect.service.js';
import fboSuppliesPackingService from './fboSuppliesPacking.service.js';
import fboSupplyReserveService from './fboSupplyReserve.service.js';
import purchasesService from './purchases.service.js';
import { looksLikeCis } from '../utils/chestnyZnak.js';

function normalizeBarcode(v) {
  return String(v || '').trim();
}

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

async function loadSupply(supplyId, profileId) {
  const pid = normalizeProfileId(profileId);
  const r = await query(
    `SELECT id, profile_id, status, marketplace, organization_id,
            deduction_warehouse_id, deduct_stock
     FROM fbo_supplies
     WHERE id = $1 AND ($2::bigint IS NULL OR profile_id = $2)
     LIMIT 1`,
    [supplyId, pid]
  );
  const row = r.rows?.[0];
  if (!row) {
    const err = new Error('Поставка не найдена');
    err.statusCode = 404;
    throw err;
  }
  return row;
}

async function findExistingCargo(supplyId, barcode) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;
  const r = await query(
    `SELECT id, barcode FROM fbo_supply_cargo_units
     WHERE fbo_supply_id = $1 AND barcode = $2
     LIMIT 1`,
    [supplyId, code]
  );
  return r.rows?.[0] || null;
}

/** ШК/SKU строки комплекта для упаковки после сборки (не ШК комплектующей). */
async function resolveExpressPackBarcode(collectResult, resolved, scannedCode) {
  const candidates = [
    collectResult?.item?.sku,
    collectResult?.item?.barcode,
    resolved?.item?.sku,
    resolved?.item?.product_sku,
    resolved?.item?.barcode,
  ];
  for (const c of candidates) {
    const t = normalizeBarcode(c);
    if (t) return t;
  }
  const productId =
    collectResult?.item?.productId ??
    collectResult?.item?.product_id ??
    resolved?.item?.product_id ??
    null;
  if (productId != null && Number(productId) > 0) {
    const r = await query(
      `SELECT TRIM(COALESCE(sku, '')) AS sku,
              (SELECT TRIM(b.barcode) FROM barcodes b
               WHERE b.product_id = p.id AND TRIM(COALESCE(b.barcode, '')) <> ''
               ORDER BY b.id LIMIT 1) AS barcode
       FROM products p WHERE p.id = $1`,
      [Number(productId)]
    );
    const row = r.rows?.[0];
    const sku = normalizeBarcode(row?.sku);
    if (sku) return sku;
    const bc = normalizeBarcode(row?.barcode);
    if (bc) return bc;
  }
  return normalizeBarcode(scannedCode);
}

class FboSuppliesExpressService {
  /**
   * @param {number|string} supplyId
   * @param {{ barcode: string, activeCargoUnitId?: number|null, scanMode?: string, allowOverage?: boolean, allowReceive?: boolean }} body
   * @param {{ profileId?: number|null, userId?: number|null, userName?: string|null }} ctx
   */
  async scan(
    supplyId,
    { barcode, activeCargoUnitId, scanMode, allowOverage = false, allowReceive = true } = {},
    { profileId, userId, userName } = {}
  ) {
    const supply = await loadSupply(supplyId, profileId);
    const code = normalizeBarcode(barcode);
    if (!code) {
      const err = new Error('Отсканируйте штрихкод');
      err.statusCode = 400;
      throw err;
    }

    const wantCargo = scanMode === 'cargo';
    const existingCargo = await findExistingCargo(supplyId, code);
    const activeId = activeCargoUnitId != null ? Number(activeCargoUnitId) : null;
    const hasActiveCargo = Number.isFinite(activeId) && activeId > 0;

    // Явный режим «новое ГМ» или скан коробки без активного ГМ — через packing
    // (там же защита: ШК товара нельзя назначить этикеткой коробки).
    if (wantCargo || (existingCargo && !hasActiveCargo)) {
      const packingResult = await fboSuppliesPackingService.scan(
        supplyId,
        {
          barcode: code,
          activeCargoUnitId,
          scanMode: wantCargo ? 'cargo' : undefined,
          allowOverage,
        },
        { profileId }
      );
      return {
        ...packingResult,
        express: true,
      };
    }

    // Есть активное ГМ: даже если ШК совпал с номером коробки — сначала пробуем как товар.
    // (Частый баг: коробку случайно назвали ШК товара в режиме «Новое грузоместо».)
    if (!hasActiveCargo) {
      // Без ГМ: на WB неизвестный штрихкод может создать коробку — делегируем packing.
      if (String(supply.marketplace || '').toLowerCase() !== 'ozon') {
        const packingResult = await fboSuppliesPackingService.scan(
          supplyId,
          { barcode: code, activeCargoUnitId: null, scanMode: undefined, allowOverage },
          { profileId }
        );
        if (
          packingResult?.action === 'cargo_created' ||
          packingResult?.action === 'cargo_selected'
        ) {
          return { ...packingResult, express: true };
        }
      }
      const err = new Error(
        'Сначала отсканируйте штрихкод грузоместа, затем товар'
      );
      err.statusCode = 400;
      err.code = 'EXPRESS_NEED_CARGO';
      throw err;
    }

    if (looksLikeCis(code)) {
      const err = new Error(
        'Это код «Честный знак». В экспрессе отсканируйте штрихкод или артикул товара.'
      );
      err.statusCode = 400;
      err.code = 'CIS_NOT_PRODUCT';
      throw err;
    }

    const resolved = await resolveScanToSupplyItem(supplyId, code, profileId, {
      userId,
      userName,
    });
    if (!resolved?.item) {
      // Не товар — если это номер другой коробки, переключим активное ГМ.
      if (existingCargo) {
        const packingResult = await fboSuppliesPackingService.scan(
          supplyId,
          {
            barcode: code,
            activeCargoUnitId: activeId,
            scanMode: undefined,
            allowOverage,
          },
          { profileId }
        );
        return { ...packingResult, express: true };
      }
      const err = new Error('Товар не найден в этой поставке');
      err.statusCode = 404;
      err.code = 'COLLECT_ITEM_NOT_FOUND';
      throw err;
    }

    const itemId = Number(resolved.item.id);
    const productId =
      resolved.item.product_id != null ? Number(resolved.item.product_id) : null;
    const isKitComponent = resolved.match === 'kit_component';
    // Приёмка с «в пути» — по факту скана: комплектующая или сам товар/комплект.
    const receiveProductId =
      isKitComponent && resolved.scannedProductId != null
        ? Number(resolved.scannedProductId)
        : productId;
    const planned = Math.max(0, parseInt(resolved.item.quantity, 10) || 0);
    const collected = Math.max(0, parseInt(resolved.item.collected_quantity, 10) || 0);

    // Предпроверка overage упаковки — до приёмки/сборки.
    if (!allowOverage) {
      const packedR = await query(
        `SELECT COALESCE(SUM(cc.quantity), 0)::int AS packed
         FROM fbo_supply_cargo_contents cc
         INNER JOIN fbo_supply_cargo_units cu ON cu.id = cc.cargo_unit_id
         WHERE cu.fbo_supply_id = $1 AND cc.fbo_supply_item_id = $2`,
        [supplyId, itemId]
      );
      const packed = Math.max(0, Number(packedR.rows?.[0]?.packed) || 0);
      if (packed >= planned) {
        const name =
          resolved.item.product_name || resolved.item.name || resolved.item.sku || 'товар';
        const err = new Error(
          `Лишний товар: «${name}». В поставке ${planned} шт., уже упаковано ${packed} шт. Добавить ещё 1 шт.?`
        );
        err.statusCode = 409;
        err.code = 'PACKING_OVERAGE';
        err.details = {
          supplyItemId: itemId,
          productName: name,
          sku: resolved.item.sku || null,
          planned,
          packed,
        };
        throw err;
      }
    }

    let received = false;
    let receiveInfo = null;

    if (supply.deduct_stock === true && receiveProductId) {
      const enriched = await fboSupplyReserveService.enrichItemsWithReserved(
        [{ id: itemId, productId, quantity: planned }],
        {
          profileId: supply.profile_id ?? null,
          reserveEnabled: true,
        }
      );
      const reservedFromStock = Math.max(0, Number(enriched?.[0]?.reservedFromStock) || 0);
      const reservedFromIncoming = Math.max(
        0,
        Number(enriched?.[0]?.reservedFromIncoming) || 0
      );
      // Для комплекта: следующий собранный комплект; для обычного товара — +1 к collected.
      // Комплектующие принимаем с «в пути», пока следующий комплект не покрыт наличием.
      const needCollect = collected + 1;

      if (needCollect > reservedFromStock) {
        if (allowReceive === false) {
          const err = new Error(
            reservedFromStock <= 0
              ? 'На складе нет свободного остатка для этой поставки: товар в пути или уже зарезервирован.'
              : `С наличия можно собрать только ${reservedFromStock} шт. Остальное в пути.`
          );
          err.statusCode = 409;
          err.code = 'COLLECT_NO_STOCK';
          throw err;
        }

        const whId = Number(supply.deduction_warehouse_id);
        if (!Number.isFinite(whId) || whId < 1) {
          const err = new Error(
            'Не задан склад списания поставки — нельзя принять товар с «в пути»'
          );
          err.statusCode = 400;
          err.code = 'EXPRESS_NO_WAREHOUSE';
          throw err;
        }

        const recv = await purchasesService.receiveOneUnitFromOpenPurchase({
          productId: receiveProductId,
          warehouseId: whId,
          profileId,
          userId,
          meta: {
            fbo_supply_id: Number(supplyId),
            fbo_supply_item_id: itemId,
            ...(isKitComponent ? { kit_component_receive: true } : {}),
          },
        });

        if (!recv) {
          const err = new Error(
            reservedFromStock <= 0
              ? 'На складе нет свободного остатка и нет открытой закупки для приёмки с «в пути».'
              : `С наличия можно собрать только ${reservedFromStock} шт. Нет открытой закупки для приёмки остатка с «в пути».`
          );
          err.statusCode = 409;
          err.code = 'COLLECT_NO_STOCK';
          err.details = { reservedFromStock, reservedFromIncoming };
          throw err;
        }
        received = true;
        receiveInfo = {
          purchaseId: recv.purchaseId,
          receiptId: recv.receiptId,
        };
      }
    }

    const collectResult = await fboSuppliesCollectService.scan(
      supplyId,
      { barcode: code, allowOverage },
      { profileId, userId, userName }
    );

    if (collectResult?.action === 'kit_progress') {
      const parts = [];
      if (received) parts.push('принята с «в пути»');
      parts.push(collectResult.message || 'комплектующая учтена');
      return {
        action: 'kit_progress',
        express: true,
        message: parts.join(' · '),
        collect: collectResult,
        kitProgress: collectResult.kitProgress || null,
        received,
        receive: receiveInfo,
        activeCargoUnitId: activeId,
        print: null,
        supplyStatus: collectResult.supplyStatus,
        lastCollectAt: collectResult.lastCollectAt,
      };
    }

    // Упаковка по SKU/ШК комплекта (строки поставки), а не по ШК комплектующей —
    // иначе packing не найдёт позицию.
    const packBarcode = await resolveExpressPackBarcode(collectResult, resolved, code);
    const unitsToPack = Math.max(1, Number(collectResult?.unitsCompleted) || 1);
    let packingResult = null;
    for (let u = 0; u < unitsToPack; u += 1) {
      packingResult = await fboSuppliesPackingService.scan(
        supplyId,
        {
          barcode: packBarcode,
          activeCargoUnitId: activeId,
          scanMode: 'product',
          // Повторные единицы того же скана (редко) — без повторного 409 overage.
          allowOverage: allowOverage || u > 0,
        },
        { profileId }
      );
    }

    const name =
      collectResult?.item?.sku ||
      collectResult?.print?.title ||
      packingResult?.message ||
      'товар';
    const parts = [];
    if (received) parts.push('принят с «в пути»');
    if (isKitComponent) parts.push('комплект собран');
    else parts.push('собран');
    parts.push('упакован');
    const message = `${name}: ${parts.join(' + ')}${
      packingResult?.quantityInCargo != null
        ? ` · в ГМ ${packingResult.quantityInCargo} шт.`
        : ''
    }`;

    return {
      action: 'express_packed',
      express: true,
      message,
      received,
      receive: receiveInfo,
      print: collectResult?.print || null,
      collect: collectResult,
      packing: packingResult?.packing,
      activeCargoUnitId: packingResult?.activeCargoUnitId ?? activeId,
      quantityInCargo: packingResult?.quantityInCargo,
      weightWarning: packingResult?.weightWarning || null,
      supplyStatus: packingResult?.supplyStatus || collectResult?.supplyStatus,
      lastCollectAt: collectResult?.lastCollectAt || null,
      lastPackAt: packingResult?.lastPackAt || null,
      packingAllMatch: packingResult?.packingAllMatch,
      statusReverted: packingResult?.statusReverted,
      statusPromoted: packingResult?.statusPromoted,
    };
  }
}

export default new FboSuppliesExpressService();
