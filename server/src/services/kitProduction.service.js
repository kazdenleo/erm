/**
 * Производство: сборка комплектов из комплектующих на складе.
 * +N комплектов на SKU комплекта, −комплектующие по составу.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import stockMovementsService from './stockMovements.service.js';
import {
  isKitProductId,
  getKitComponents,
  buildKitComponentQtyMap,
  computeAssemblableFromComponents,
  readKitPhysicalOnHandFromDb,
} from './kitStock.service.js';
import { computeAvailableQuantity } from './sellableQuantity.service.js';

/**
 * Движения остатков при сборке комплекта (общая логика для приёмки и производства).
 */
export async function applyKitAssemblyMovements({
  kitProductId,
  quantity,
  warehouseId,
  reason,
  metaExtra = {},
}) {
  const kitId = Number(kitProductId);
  const kits = Math.max(1, parseInt(quantity, 10) || 1);
  const components = await getKitComponents(kitId);
  if (!components.length) {
    const err = new Error('У комплекта не задан состав kit_components');
    err.statusCode = 400;
    throw err;
  }
  const compQtyMap = buildKitComponentQtyMap(components, kits);

  for (const [compId, compQty] of compQtyMap) {
    const metrics = await computeAvailableQuantity(compId, {
      warehouseId,
      supplierSyncEnabled: false,
    });
    const onHand = Math.max(0, Number(metrics.onHand) || 0);
    if (onHand < compQty) {
      const err = new Error(
        `Недостаточно комплектующих: product #${compId}, нужно ${compQty}, на складе ${onHand}`
      );
      err.statusCode = 409;
      throw err;
    }
  }

  const metaBase = {
    warehouse_id: warehouseId,
    kit_assembly_receipt: true,
    kit_product_id: kitId,
    kit_units: kits,
    ...metaExtra,
  };

  const applyMoves = async () => {
    await stockMovementsService.applyChange(kitId, {
      delta: kits,
      type: 'receipt',
      reason,
      meta: metaBase,
    });
    for (const [compId, compQty] of compQtyMap) {
      await stockMovementsService.applyChange(compId, {
        delta: -compQty,
        type: 'shipment',
        reason: `${reason}: комплектующие для сборки комплекта`,
        meta: { ...metaBase, kit_component_deduct: true },
      });
    }
  };

  // Без внешнего session lock: applyChange внутри вызывает пересчёт резервов/FBO
  // с runWithProductStockLock по тому же product_id → вложенный lock зависает до таймаута HTTP.
  await applyMoves();

  return { kitProductId: kitId, quantity: kits, componentsDeducted: Object.fromEntries(compQtyMap) };
}

async function loadKitProductRow(kitProductId) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return null;
  const r = await query(
    `SELECT id, sku, name, product_type FROM products WHERE id = $1 LIMIT 1`,
    [kitId]
  );
  return r.rows?.[0] || null;
}

async function loadComponentRows(kitProductId) {
  const kitId = Number(kitProductId);
  const r = await query(
    `SELECT kc.component_product_id, kc.quantity AS per_kit,
            p.sku, p.name
     FROM kit_components kc
     INNER JOIN products p ON p.id = kc.component_product_id
     WHERE kc.kit_product_id = $1
     ORDER BY kc.id`,
    [kitId]
  );
  return r.rows || [];
}

export async function getKitProductionPreview(kitProductId, warehouseId) {
  const productsRepo = repositoryFactory.getProductsRepository();
  const wid = await productsRepo.resolveStrictOwnWarehouseId(warehouseId);
  if (!wid) {
    const err = new Error('Укажите склад');
    err.statusCode = 400;
    throw err;
  }

  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) {
    const err = new Error('Укажите комплект');
    err.statusCode = 400;
    throw err;
  }
  if (!(await isKitProductId(kitId))) {
    const err = new Error('Товар не является комплектом');
    err.statusCode = 400;
    throw err;
  }

  const kit = await loadKitProductRow(kitId);
  const componentRows = await loadComponentRows(kitId);
  if (!componentRows.length) {
    const err = new Error('У комплекта не задан состав');
    err.statusCode = 400;
    throw err;
  }

  const components = [];
  for (const row of componentRows) {
    const compId = Number(row.component_product_id);
    const perKit = Math.max(1, parseInt(row.per_kit, 10) || 1);
    const metrics = await computeAvailableQuantity(compId, {
      warehouseId: wid,
      supplierSyncEnabled: false,
    });
    const onHand = Math.max(0, Number(metrics.onHand) || 0);
    components.push({
      productId: compId,
      sku: row.sku || null,
      name: row.name || null,
      perKit,
      onHand,
      maxKitsFromComponent: Math.floor(onHand / perKit),
    });
  }

  const assemblable = await computeAssemblableFromComponents(kitId, { warehouseId: wid });
  const kitsOnHand = await readKitPhysicalOnHandFromDb(kitId, null, { warehouseId: wid });

  return {
    kit: {
      id: kitId,
      sku: kit?.sku || null,
      name: kit?.name || null,
    },
    warehouseId: wid,
    assemblable,
    kitsOnHand: Math.max(0, Number(kitsOnHand) || 0),
    components,
  };
}

export async function assembleKitProduction({ kitProductId, warehouseId, quantity }) {
  const productsRepo = repositoryFactory.getProductsRepository();
  const wid = await productsRepo.resolveStrictOwnWarehouseId(warehouseId);
  if (!wid) {
    const err = new Error('Укажите склад');
    err.statusCode = 400;
    throw err;
  }

  const kitId = Number(kitProductId);
  const kits = Math.max(1, parseInt(quantity, 10) || 1);
  if (!Number.isFinite(kitId) || kitId < 1) {
    const err = new Error('Укажите комплект');
    err.statusCode = 400;
    throw err;
  }
  if (!(await isKitProductId(kitId))) {
    const err = new Error('Товар не является комплектом');
    err.statusCode = 400;
    throw err;
  }

  const assemblable = await computeAssemblableFromComponents(kitId, { warehouseId: wid });
  if (kits > assemblable) {
    const err = new Error(
      `Нельзя собрать ${kits} шт.: из комплектующих на складе можно собрать не более ${assemblable}`
    );
    err.statusCode = 409;
    throw err;
  }

  const kit = await loadKitProductRow(kitId);
  const label = kit?.sku || kit?.name || `#${kitId}`;
  const reason = `Производство: сборка комплекта ${label}, ${kits} шт.`;

  const result = await applyKitAssemblyMovements({
    kitProductId: kitId,
    quantity: kits,
    warehouseId: wid,
    reason,
    metaExtra: { source: 'production' },
  });

  const kitsOnHand = await readKitPhysicalOnHandFromDb(kitId, null, { warehouseId: wid });

  return {
    ...result,
    kit: {
      id: kitId,
      sku: kit?.sku || null,
      name: kit?.name || null,
    },
    warehouseId: wid,
    kitsOnHand: Math.max(0, Number(kitsOnHand) || 0),
  };
}

const kitProductionService = {
  getKitProductionPreview,
  assembleKitProduction,
  applyKitAssemblyMovements,
};

export default kitProductionService;
