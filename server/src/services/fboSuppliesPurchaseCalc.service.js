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
    `SELECT id, name, sku, COALESCE(cost, 0)::numeric AS cost, supplier_id
     FROM products
     WHERE id = ANY($1::bigint[])`,
    [productIds]
  );
  for (const row of r.rows || []) {
    map.set(Number(row.id), {
      name: row.name,
      sku: row.sku,
      cost: Number(row.cost) || 0,
      supplierId: row.supplier_id != null ? Number(row.supplier_id) : null,
    });
  }
  return map;
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

function mergeKitHeaderCell(existing, meta) {
  if (!existing) {
    return { supplyItemId: meta.supplyItemId, quantity: meta.quantity, isKitLine: true };
  }
  if (
    !existing.parts &&
    existing.supplyItemId === meta.supplyItemId
  ) {
    return { ...existing, quantity: (Number(existing.quantity) || 0) + meta.quantity };
  }
  const parts = existing.parts || [
    { supplyItemId: existing.supplyItemId, quantity: existing.quantity },
  ];
  const idx = parts.findIndex((p) => p.supplyItemId === meta.supplyItemId);
  if (idx >= 0) {
    parts[idx] = {
      supplyItemId: meta.supplyItemId,
      quantity: (Number(parts[idx].quantity) || 0) + meta.quantity,
    };
  } else {
    parts.push({ supplyItemId: meta.supplyItemId, quantity: meta.quantity });
  }
  const totalQty = parts.reduce((s, p) => s + (Number(p.quantity) || 0), 0);
  return {
    isKitLine: true,
    parts,
    multiSource: parts.length > 1,
    supplyItemId: parts[0].supplyItemId,
    quantity: totalQty,
  };
}

function addKitLine(
  kitHeaderMap,
  componentRowMap,
  {
    supplyId,
    supplyItemId,
    kitProductId,
    kitQty,
    kitLabel,
    kitSku,
    components,
    productInfoById,
    onHandByProduct,
    incomingByProduct,
  }
) {
  if (!kitHeaderMap.has(kitProductId)) {
    kitHeaderMap.set(kitProductId, {
      key: `kit:p:${kitProductId}`,
      rowType: 'kit',
      kitProductId,
      productName: kitLabel,
      sku: kitSku || null,
      supplyQty: {},
      supplyCells: {},
      supplyItemIds: [],
    });
  }
  const header = kitHeaderMap.get(kitProductId);
  header.supplyQty[supplyId] = (Number(header.supplyQty[supplyId]) || 0) + kitQty;
  header.supplyCells[supplyId] = mergeKitHeaderCell(header.supplyCells[supplyId], {
    supplyItemId,
    quantity: kitQty,
  });
  if (!header.supplyItemIds.includes(supplyItemId)) {
    header.supplyItemIds.push(supplyItemId);
  }

  for (const comp of components) {
    const compId = comp.component_product_id;
    const perKit = comp.quantity;
    const componentQty = kitQty * perKit;
    const info = productInfoById.get(compId) || {};
    const compKey = `kit:p:${kitProductId}:c:${compId}`;
    const agg = ensureProductRow(componentRowMap, compKey, {
      productId: compId,
      productName: info.name || `Товар #${compId}`,
      sku: info.sku || null,
      barcode: null,
      cost: info.cost ?? 0,
      onHand: onHandByProduct.get(compId) ?? 0,
      incoming: incomingByProduct.get(compId) ?? 0,
    });
    agg.rowType = 'component';
    agg.parentKey = header.key;
    agg.kitProductId = kitProductId;
    agg.kitSources = [{ kitProductId, label: kitLabel }];
    const prevQty = agg.supplyQty[supplyId] || 0;
    agg.supplyQty[supplyId] = prevQty + componentQty;
    agg.supplyCells[supplyId] = mergeSupplyCell(agg.supplyCells[supplyId], {
      supplyItemId,
      quantity: kitQty,
      kitProductId,
      perKit,
    });
    if (!agg.supplyItemIds.includes(supplyItemId)) {
      agg.supplyItemIds.push(supplyItemId);
    }
  }
}

function finalizeKitHeaderRow(header) {
  const supplyQtyTotal = Object.values(header.supplyQty || {}).reduce(
    (s, v) => s + (Number(v) || 0),
    0
  );
  return {
    ...header,
    rowType: 'kit',
    isKitHeader: true,
    supplyQtyTotal,
    onHand: null,
    incoming: null,
    cost: null,
    toPurchase: 0,
    lineCostTotal: 0,
    perKit: null,
    isKitComponentRow: false,
  };
}

function finalizePurchaseRow(r) {
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
  const isKitComponentRow = r.rowType === 'component' || (r.kitSources?.length ?? 0) > 0;
  const perKit = isKitComponentRow ? rowPerKitFromCells(r) : 1;
  r.supplyQtyTotal = computeSupplyComponentQtyTotal(r);
  const available = (Number(r.onHand) || 0) + (Number(r.incoming) || 0);
  const toPurchase = Math.max(0, r.supplyQtyTotal - available);
  const lineCostTotal = Math.round(toPurchase * r.cost * 100) / 100;
  return {
    ...r,
    rowType: r.rowType || (isKitComponentRow ? 'component' : 'plain'),
    isKitComponentRow,
    perKit,
    toPurchase,
    lineCostTotal,
  };
}

function isRowFullyCleared(row) {
  if (!row) return true;
  return (Number(row.supplyQtyTotal) || 0) === 0;
}

function groupFullyCleared(group) {
  if (group.header) {
    const headerClear = isRowFullyCleared(group.header);
    const compsClear = (group.components || []).every(isRowFullyCleared);
    return headerClear && compsClear;
  }
  const row = group.components?.[0];
  return row ? isRowFullyCleared(row) : true;
}

/** Очищенные (все поставки = 0) вниз; внутри блоков — по имени. */
function sortPurchaseDisplayRows(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (row.rowType === 'kit' || row.isKitHeader) {
      current = { header: row, components: [] };
      groups.push(current);
      continue;
    }
    if (row.rowType === 'component' && current) {
      current.components.push(row);
      continue;
    }
    current = null;
    groups.push({ header: null, components: [row] });
  }

  groups.sort((a, b) => {
    const aDone = groupFullyCleared(a);
    const bDone = groupFullyCleared(b);
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aName = a.header?.productName || a.components[0]?.productName || '';
    const bName = b.header?.productName || b.components[0]?.productName || '';
    return String(aName).localeCompare(String(bName), 'ru');
  });

  const out = [];
  for (const g of groups) {
    if (g.header) out.push(g.header);
    out.push(...g.components);
  }
  return out;
}

function buildPurchaseDisplayRows(kitHeaderMap, componentRowMap, plainRowMap) {
  const componentRows = [...componentRowMap.values()].map(finalizePurchaseRow);
  const plainRows = [...plainRowMap.values()].map((r) =>
    finalizePurchaseRow({ ...r, rowType: 'plain' })
  );

  const kitHeaders = [...kitHeaderMap.values()]
    .map(finalizeKitHeaderRow)
    .sort((a, b) =>
      String(a.productName || a.sku || '').localeCompare(String(b.productName || b.sku || ''), 'ru')
    );

  const rows = [];
  for (const header of kitHeaders) {
    rows.push(header);
    const comps = componentRows
      .filter((r) => r.kitProductId === header.kitProductId)
      .sort((a, b) =>
        String(a.productName || a.sku || '').localeCompare(String(b.productName || b.sku || ''), 'ru')
      );
    rows.push(...comps);
  }
  rows.push(...plainRows);
  return sortPurchaseDisplayRows(rows);
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

  async calculate(supplyIds, { profileId, supplierId = null } = {}) {
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
    const kitIdsWithComponents = [...kitComponentsByKitId.keys()];
    const productInfoById = await loadProductInfoById([
      ...componentIds,
      ...plainProductIds,
      ...kitIdsWithComponents,
    ]);

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

    const kitHeaderMap = new Map();
    const componentRowMap = new Map();
    const plainRowMap = new Map();

    for (const row of itemsR.rows || []) {
      const supplyId = Number(row.fbo_supply_id);
      const qty = Number(row.quantity) || 0;
      const productId = row.product_id != null ? Number(row.product_id) : null;
      const components = productId != null ? kitComponentsByKitId.get(productId) : null;

      if (components?.length) {
        const kitInfo = productInfoById.get(productId) || {};
        addKitLine(kitHeaderMap, componentRowMap, {
          supplyId,
          supplyItemId: row.supply_item_id,
          kitProductId: productId,
          kitQty: qty,
          kitLabel: row.product_name || kitInfo.name || row.sku || `Комплект #${productId}`,
          kitSku: row.sku || kitInfo.sku || null,
          components,
          productInfoById,
          onHandByProduct,
          incomingByProduct,
        });
        continue;
      }

      const key = productId != null ? `p:${productId}` : `item:${row.supply_item_id}`;
      const info = productId != null ? productInfoById.get(productId) : null;
      const agg = ensureProductRow(plainRowMap, key, {
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

    const rows = buildPurchaseDisplayRows(kitHeaderMap, componentRowMap, plainRowMap);

    const filterSid =
      supplierId != null && supplierId !== '' && !Number.isNaN(Number(supplierId))
        ? Number(supplierId)
        : null;
    const rowsWithSupplier = rows.map((row) => {
      const pid = row.productId != null ? Number(row.productId) : null;
      const info = pid != null ? productInfoById.get(pid) : null;
      return {
        ...row,
        supplierId: info?.supplierId ?? null,
      };
    });
    const filteredRows =
      filterSid != null
        ? rowsWithSupplier.filter((row) => {
            if (row.isKitHeader || row.rowType === 'kit') return true;
            const sid = row.supplierId != null ? Number(row.supplierId) : null;
            return sid == null || sid === filterSid;
          })
        : rowsWithSupplier;

    const purchasableRows = filteredRows.filter((r) => r.rowType !== 'kit' && !r.isKitHeader);
    const totals = purchasableRows.reduce(
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
      rows: filteredRows,
      totals,
      defaultOrganizationId,
      defaultWarehouseId: fboWh.id,
      supplierFilterId: filterSid,
    };
  }
}

export default new FboSuppliesPurchaseCalcService();
