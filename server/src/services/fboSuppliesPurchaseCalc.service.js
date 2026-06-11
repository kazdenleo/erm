/**
 * Расчёт закупки по выбранным поставкам FBO.
 * Комплекты в поставке раскрываются в комплектующие (закупаем детали, не SKU комплекта).
 */

import { query } from '../config/database.js';

function normalizeProfileId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  return Number.isNaN(n) ? null : n;
}

function normalizeSupplyIds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const out = [];
  for (const raw of list) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

async function getFboWarehouse(profileId) {
  const pid = normalizeProfileId(profileId);
  if (!pid) return null;
  const r = await query(
    `SELECT id, COALESCE(NULLIF(TRIM(address), ''), 'Склад #' || id::text) AS label
     FROM warehouses
     WHERE profile_id = $1 AND is_fbo_stock = TRUE AND type = 'warehouse'
     LIMIT 1`,
    [pid]
  );
  return r.rows?.[0] ? { id: Number(r.rows[0].id), label: r.rows[0].label } : null;
}

async function loadKitComponentsByKitId(kitProductIds) {
  const map = new Map();
  if (!kitProductIds.length) return map;
  const r = await query(
    `SELECT kit_product_id, component_product_id, quantity
     FROM kit_components
     WHERE kit_product_id = ANY($1::bigint[])
     ORDER BY kit_product_id, id`,
    [kitProductIds]
  );
  for (const row of r.rows || []) {
    const kitId = Number(row.kit_product_id);
    if (!map.has(kitId)) map.set(kitId, []);
    map.get(kitId).push({
      component_product_id: Number(row.component_product_id),
      quantity: Math.max(1, parseInt(row.quantity, 10) || 1),
    });
  }
  return map;
}

async function loadProductInfoById(productIds) {
  const map = new Map();
  if (!productIds.length) return map;
  const r = await query(
    `SELECT id, name, sku, COALESCE(cost, 0)::numeric AS cost
     FROM products
     WHERE id = ANY($1::bigint[])`,
    [productIds]
  );
  for (const row of r.rows || []) {
    map.set(Number(row.id), {
      name: row.name,
      sku: row.sku,
      cost: Number(row.cost) || 0,
    });
  }
  return map;
}

function mergeKitSource(sources, kitProductId, label) {
  if (!sources.some((s) => s.kitProductId === kitProductId)) {
    sources.push({ kitProductId, label: label || `Комплект #${kitProductId}` });
  }
}

function toSupplyCellPart(meta) {
  return {
    supplyItemId: meta.supplyItemId,
    quantity: meta.quantity,
    kitProductId: meta.kitProductId,
    perKit: meta.perKit,
  };
}

function mergeSupplyCell(existing, meta) {
  if (!existing) {
    return { ...meta, isKitComponent: true };
  }
  if (
    existing.isKitComponent &&
    !existing.parts &&
    existing.supplyItemId === meta.supplyItemId &&
    existing.kitProductId === meta.kitProductId
  ) {
    return { ...existing, quantity: meta.quantity, perKit: meta.perKit };
  }
  const parts = existing.parts || [toSupplyCellPart(existing)];
  const idx = parts.findIndex(
    (p) => p.supplyItemId === meta.supplyItemId && p.kitProductId === meta.kitProductId
  );
  if (idx >= 0) {
    parts[idx] = toSupplyCellPart(meta);
  } else {
    parts.push(toSupplyCellPart(meta));
  }
  return { isKitComponent: true, parts, multiSource: parts.length > 1 };
}

function computeSupplyComponentQtyTotal(row) {
  const supplyQty = row.supplyQty || {};
  const supplyCells = row.supplyCells || {};
  let total = 0;
  for (const [supplyId, raw] of Object.entries(supplyQty)) {
    const cell = supplyCells[supplyId];
    if (cell?.isKitComponent) {
      const perKit = Math.max(1, Number(cell.perKit) || 1);
      const kitUnits = Number(cell.quantity) || 0;
      const componentFromKit = kitUnits * perKit;
      const stored = Number(raw) || 0;
      if (perKit > 1 && stored > 0 && stored === kitUnits) {
        total += componentFromKit;
      } else {
        total += stored > 0 ? stored : componentFromKit;
      }
    } else {
      total += Number(raw) || 0;
    }
  }
  return total;
}

function rowPerKitFromCells(row) {
  let max = 1;
  for (const cell of Object.values(row.supplyCells || {})) {
    if (cell?.isKitComponent && cell.perKit) {
      max = Math.max(max, Number(cell.perKit) || 1);
    }
  }
  return max;
}

function ensureProductRow(rowMap, key, init) {
  if (!rowMap.has(key)) {
    rowMap.set(key, {
      key,
      productId: init.productId,
      supplyItemIds: [],
      productName: init.productName,
      sku: init.sku,
      barcode: init.barcode,
      cost: init.cost,
      onHand: init.onHand,
      incoming: init.incoming,
      supplyQty: {},
      supplyCells: {},
      supplyQtyTotal: 0,
      kitSources: [],
    });
  }
  return rowMap.get(key);
}

function addPlainSupplyLine(agg, supplyId, supplyItemId, qty) {
  const prevQty = agg.supplyQty[supplyId] || 0;
  agg.supplyQty[supplyId] = prevQty + qty;
  if (!agg.supplyCells[supplyId]) {
    agg.supplyCells[supplyId] = { supplyItemId, quantity: qty };
  } else {
    agg.supplyCells[supplyId].quantity += qty;
  }
  agg.supplyItemIds.push(supplyItemId);
}

function addKitComponentDemand(
  rowMap,
  {
    supplyId,
    supplyItemId,
    kitProductId,
    kitQty,
    kitLabel,
    components,
    productInfoById,
    onHandByProduct,
    incomingByProduct,
  }
) {
  for (const comp of components) {
    const compId = comp.component_product_id;
    const perKit = comp.quantity;
    const componentQty = kitQty * perKit;
    const info = productInfoById.get(compId) || {};
    const key = `p:${compId}`;
    const agg = ensureProductRow(rowMap, key, {
      productId: compId,
      productName: info.name || `Товар #${compId}`,
      sku: info.sku || null,
      barcode: null,
      cost: info.cost ?? 0,
      onHand: onHandByProduct.get(compId) ?? 0,
      incoming: incomingByProduct.get(compId) ?? 0,
    });
    mergeKitSource(agg.kitSources, kitProductId, kitLabel);
    const prevQty = agg.supplyQty[supplyId] || 0;
    agg.supplyQty[supplyId] = prevQty + componentQty;
    agg.supplyCells[supplyId] = mergeSupplyCell(agg.supplyCells[supplyId], {
      supplyItemId,
      quantity: kitQty,
      kitProductId,
      perKit,
    });
    agg.supplyItemIds.push(supplyItemId);
  }
}

class FboSuppliesPurchaseCalcService {
  async assertSuppliesAccessible(supplyIds, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    const ids = normalizeSupplyIds(supplyIds);
    if (!ids.length) {
      const err = new Error('Выберите хотя бы одну поставку');
      err.statusCode = 400;
      throw err;
    }
    const r = await query(
      `SELECT id FROM fbo_supplies
       WHERE id = ANY($1::bigint[]) AND ($2::bigint IS NULL OR profile_id = $2)`,
      [ids, pid]
    );
    if ((r.rows?.length ?? 0) !== ids.length) {
      const err = new Error('Часть поставок не найдена или недоступна');
      err.statusCode = 404;
      throw err;
    }
  }

  async calculate(supplyIds, { profileId } = {}) {
    const pid = normalizeProfileId(profileId);
    const ids = normalizeSupplyIds(supplyIds);
    if (!ids.length) {
      const err = new Error('Выберите хотя бы одну поставку');
      err.statusCode = 400;
      throw err;
    }

    const fboWh = await getFboWarehouse(pid);
    if (!fboWh) {
      const err = new Error(
        'Не указан склад FBO. Отметьте один склад как «Склад FBO» в разделе Склады.'
      );
      err.statusCode = 400;
      throw err;
    }

    const suppliesR = await query(
      `SELECT s.id, s.external_shipment_number, s.name, s.placement_cluster,
              s.organization_id, o.name AS organization_name
       FROM fbo_supplies s
       LEFT JOIN organizations o ON o.id = s.organization_id
       WHERE s.id = ANY($1::bigint[])
         AND ($2::bigint IS NULL OR s.profile_id = $2)
       ORDER BY s.id`,
      [ids, pid]
    );
    if ((suppliesR.rows?.length ?? 0) !== ids.length) {
      const err = new Error('Часть поставок не найдена или недоступна');
      err.statusCode = 404;
      throw err;
    }

    const supplies = (suppliesR.rows || []).map((row) => {
      const placementCluster =
        row.placement_cluster != null ? String(row.placement_cluster).trim() : '';
      const shipment =
        row.external_shipment_number != null ? String(row.external_shipment_number).trim() : '';
      const name = row.name != null ? String(row.name).trim() : '';
      const label =
        placementCluster ||
        shipment ||
        name ||
        `Поставка #${row.id}`;
      const titleParts = [
        placementCluster ? `Кластер: ${placementCluster}` : null,
        shipment ? `№ ${shipment}` : null,
        name || null,
        `ID ${row.id}`,
      ].filter(Boolean);
      return {
        id: row.id,
        label,
        placementCluster: placementCluster || null,
        externalShipmentNumber: row.external_shipment_number,
        name: row.name,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        columnTitle: titleParts.join(' · '),
      };
    });

    const itemsR = await query(
      `SELECT i.id AS supply_item_id, i.fbo_supply_id, i.product_id, i.quantity, i.sku, i.barcode,
              COALESCE(p.name, i.name) AS product_name,
              COALESCE(p.cost, 0)::numeric AS cost
       FROM fbo_supply_items i
       LEFT JOIN products p ON p.id = i.product_id
       WHERE i.fbo_supply_id = ANY($1::bigint[])
       ORDER BY i.fbo_supply_id, i.id`,
      [ids]
    );

    const kitProductIds = [
      ...new Set(
        (itemsR.rows || [])
          .map((r) => r.product_id)
          .filter((id) => id != null)
          .map((id) => Number(id))
      ),
    ];
    const kitComponentsByKitId = await loadKitComponentsByKitId(kitProductIds);

    const componentIds = new Set();
    for (const comps of kitComponentsByKitId.values()) {
      for (const c of comps) componentIds.add(c.component_product_id);
    }

    const plainProductIds = [
      ...new Set(
        (itemsR.rows || [])
          .map((r) => r.product_id)
          .filter((id) => id != null)
          .map((id) => Number(id))
          .filter((id) => !(kitComponentsByKitId.get(id)?.length > 0))
      ),
    ];

    const stockProductIds = [...new Set([...plainProductIds, ...componentIds])];
    const productInfoById = await loadProductInfoById([...componentIds, ...plainProductIds]);

    const onHandByProduct = new Map();
    if (stockProductIds.length) {
      const stockR = await query(
        `SELECT product_id, COALESCE(quantity, 0)::int AS qty
         FROM product_warehouse_stock
         WHERE warehouse_id = $1 AND product_id = ANY($2::bigint[])`,
        [fboWh.id, stockProductIds]
      );
      for (const row of stockR.rows || []) {
        onHandByProduct.set(Number(row.product_id), Number(row.qty) || 0);
      }
    }

    const incomingByProduct = new Map();
    if (stockProductIds.length) {
      const incR = await query(
        `SELECT id, COALESCE(incoming_quantity, 0)::int AS incoming
         FROM products
         WHERE id = ANY($1::bigint[])`,
        [stockProductIds]
      );
      for (const row of incR.rows || []) {
        incomingByProduct.set(Number(row.id), Number(row.incoming) || 0);
      }
    }

    const rowMap = new Map();

    for (const row of itemsR.rows || []) {
      const supplyId = Number(row.fbo_supply_id);
      const qty = Number(row.quantity) || 0;
      const productId = row.product_id != null ? Number(row.product_id) : null;
      const components = productId != null ? kitComponentsByKitId.get(productId) : null;

      if (components?.length) {
        addKitComponentDemand(rowMap, {
          supplyId,
          supplyItemId: row.supply_item_id,
          kitProductId: productId,
          kitQty: qty,
          kitLabel: row.product_name || row.sku || `Комплект #${productId}`,
          components,
          productInfoById,
          onHandByProduct,
          incomingByProduct,
        });
        continue;
      }

      const key = productId != null ? `p:${productId}` : `item:${row.supply_item_id}`;
      const info = productId != null ? productInfoById.get(productId) : null;
      const agg = ensureProductRow(rowMap, key, {
        productId,
        productName: row.product_name || info?.name,
        sku: row.sku || info?.sku,
        barcode: row.barcode,
        cost:
          productId != null
            ? Number(info?.cost ?? row.cost) || 0
            : Number(row.cost) || 0,
        onHand: productId != null ? onHandByProduct.get(productId) ?? 0 : 0,
        incoming: productId != null ? incomingByProduct.get(productId) ?? 0 : 0,
      });
      addPlainSupplyLine(agg, supplyId, row.supply_item_id, qty);
    }

    const rows = [...rowMap.values()].map((r) => {
      for (const [supplyId, cell] of Object.entries(r.supplyCells || {})) {
        if (!cell?.isKitComponent) continue;
        const perKit = Math.max(1, Number(cell.perKit) || 1);
        const kitUnits = Number(cell.quantity) || 0;
        const componentQty = kitUnits * perKit;
        const stored = Number(r.supplyQty[supplyId]) || 0;
        if (!stored || stored === kitUnits) {
          r.supplyQty[supplyId] = componentQty;
        }
      }
      const isKitComponentRow = (r.kitSources?.length ?? 0) > 0;
      const perKit = isKitComponentRow ? rowPerKitFromCells(r) : 1;
      r.supplyQtyTotal = computeSupplyComponentQtyTotal(r);
      const available = (Number(r.onHand) || 0) + (Number(r.incoming) || 0);
      const toPurchase = Math.max(0, r.supplyQtyTotal - available);
      const lineCostTotal = Math.round(toPurchase * r.cost * 100) / 100;
      return {
        ...r,
        isKitComponentRow,
        perKit,
        toPurchase,
        lineCostTotal,
      };
    });

    rows.sort((a, b) => {
      const aDone = a.toPurchase === 0;
      const bDone = b.toPurchase === 0;
      if (aDone !== bDone) return aDone ? 1 : -1;
      return String(a.productName || a.sku || '').localeCompare(
        String(b.productName || b.sku || ''),
        'ru'
      );
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.toPurchaseQty += r.toPurchase;
        acc.costSum += r.lineCostTotal;
        return acc;
      },
      { toPurchaseQty: 0, costSum: 0 }
    );
    totals.costSum = Math.round(totals.costSum * 100) / 100;

    const defaultOrganizationId = supplies.find((s) => s.organizationId)?.organizationId ?? null;

    return {
      fboWarehouse: fboWh,
      supplies,
      rows,
      totals,
      defaultOrganizationId,
      defaultWarehouseId: fboWh.id,
    };
  }
}

export default new FboSuppliesPurchaseCalcService();
