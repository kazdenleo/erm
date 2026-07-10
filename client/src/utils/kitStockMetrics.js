/**
 * Комплекты в таблице «Остатки на складе»:
 *
 * - Наличие / в пути / резерв — только по SKU строки (комплект или комплектующее).
 * - Доступно: слева — целые комплекты к продаже (наличие + в пути − резерв на SKU комплекта);
 *   в скобках — всего к продаже с учётом резерва (целые + собираемость − резерв комплекта).
 *   Пример: 1 (8) — 1 целый; после резерва 3 комплектов из деталей: 1 (5).
 */

/** В таблице «Остатки на складе»: наличие + в пути − резерв + поставщики (не ниже 0). */
export function stockTableAvailable({ onHand, incoming = 0, reserved = 0, suppliers = 0 } = {}) {
  const a =
    (Number(onHand) || 0) +
    (Number(incoming) || 0) +
    (Number(suppliers) || 0) -
    (Number(reserved) || 0);
  return Math.max(0, a);
}

export function isKitProduct(product) {
  if (!product) return false;
  if (String(product.product_type || '').toLowerCase() === 'kit') return true;
  if (product.is_kit_catalog === true || product.isKitCatalog === true) return true;
  const comps = product.kit_components ?? product.kitComponents;
  return Array.isArray(comps) && comps.length > 0;
}

/** Обычный SKU, но входит в состав хотя бы одного комплекта. */
export function isKitComponentProduct(product) {
  if (!product) return false;
  return product.is_kit_component === true || product.isKitComponent === true;
}

/** Почему в таблице остатков нельзя править «Наличие» вручную (null — можно). */
export function manualWarehouseStockEditBlockedReason({
  allowManualStockEdit = false,
  warehouseId = null,
} = {}) {
  if (!allowManualStockEdit) {
    return 'Включите «Ручное изменение наличия на складе» в настройках аккаунта';
  }
  if (!warehouseId) {
    return 'Выберите склад в фильтре «Склад (остаток)» над таблицей';
  }
  return null;
}

/** Типы движений в истории остатков комплекта (SKU + резерв / «в пути»). */
export const KIT_STOCK_HISTORY_MOVEMENT_TYPES = [
  'receipt',
  'shipment',
  'writeoff',
  'inventory',
  'manual',
  'transfer',
  'opening_balance',
  'customer_return',
  'return_to_supplier',
  'reserve',
  'unreserve',
  'incoming'
];

export function isKitStockHistoryMovementType(type) {
  return KIT_STOCK_HISTORY_MOVEMENT_TYPES.includes(String(type || '').toLowerCase());
}

export function isKitStockHistoryMovement(movement, product) {
  if (!isKitProduct(product)) return true;
  const t = movement?.type ?? movement?.movement_type ?? movement?.movementType;
  if (movement?.meta?.kit_component_reserve === true) return true;
  if (movement?.meta?.kit_component_return_to_supplier === true) return true;
  if (
    movement?.meta?.kit_component_incoming === true ||
    movement?.meta?.kit_component_incoming === 'true'
  ) {
    return true;
  }
  return isKitStockHistoryMovementType(t);
}

/** @returns {null|object} метрики kit_display для таблицы остатков */
export function parseKitDisplayMetrics(product) {
  const raw = product?.kit_display ?? product?.kitDisplay ?? product?.kit_stock_split ?? product?.kitStockSplit;
  if (!raw || typeof raw !== 'object') return null;
  const n = (snake, camel) => Math.max(0, Number(raw[snake] ?? raw[camel]) || 0);
  const wholeOnHand = n('whole_on_hand', 'wholeOnHand');
  const assemblable = n('assemblable_from_components', 'assemblableFromComponents');
  const wholeAvailable =
    raw.whole_available != null || raw.wholeAvailable != null
      ? n('whole_available', 'wholeAvailable')
      : null;
  const reservedOnSku = n('reserved_on_sku', 'reservedOnSku');
  const marketplaceAvailable =
    raw.marketplace_available != null || raw.marketplaceAvailable != null
      ? n('marketplace_available', 'marketplaceAvailable')
      : null;
  const availableTotal =
    raw.available_total != null || raw.availableTotal != null
      ? n('available_total', 'availableTotal')
      : (marketplaceAvailable ?? wholeAvailable ?? wholeOnHand) + assemblable;
  return {
    whole_on_hand: wholeOnHand,
    whole_available: wholeAvailable,
    reserved_on_sku: reservedOnSku,
    assemblable_from_components: assemblable,
    incoming_from_components: n('incoming_from_components', 'incomingFromComponents'),
    marketplace_available: marketplaceAvailable,
    supplier_kit_units: n('supplier_kit_units', 'supplierKitUnits'),
    available_total: availableTotal
  };
}

/** Целые комплекты к продаже: наличие + в пути − резерв (без собираемости из деталей). */
export function kitWholeAvailableFromMetrics(metrics, product = null) {
  if (!metrics) return 0;
  if (metrics.whole_available != null && !Number.isNaN(Number(metrics.whole_available))) {
    return Math.max(0, Number(metrics.whole_available));
  }
  const wholeOnHand = Math.max(0, Number(metrics.whole_on_hand) || 0);
  if (!product) return wholeOnHand;
  const incoming = Math.max(0, Number(product.incoming_quantity ?? product.incomingQuantity) || 0);
  const reserved = Math.max(
    0,
    Number(
      product.net_reserved_quantity ??
        product.netReservedQuantity ??
        product.reserved_quantity ??
        product.reservedQuantity
    ) || 0
  );
  return Math.max(0, wholeOnHand + incoming - reserved);
}

/** В скобках: всего к продаже на МП (целые к продаже + собираемость из комплектующих). */
export function kitSellableTotalFromMetrics(metrics, product = null) {
  if (!metrics) return 0;
  if (metrics.marketplace_available != null && !Number.isNaN(Number(metrics.marketplace_available))) {
    return Math.max(0, Number(metrics.marketplace_available));
  }
  return Math.max(0, kitWholeAvailableFromMetrics(metrics, product) + (Number(metrics.assemblable_from_components) || 0));
}

export function formatKitAvailableDisplay(metrics, product = null) {
  if (!metrics) return null;
  const wholeAvail = kitWholeAvailableFromMetrics(metrics, product);
  const sellableTotal = kitSellableTotalFromMetrics(metrics, product);
  return `${wholeAvail} (${sellableTotal})`;
}

/** Число в скобках колонки «Доступно» — для экспорта на МП. */
export function kitMarketplaceAvailableFromMetrics(metrics, product = null) {
  const base = kitSellableTotalFromMetrics(metrics, product);
  const supplier = Math.max(0, Number(metrics?.supplier_kit_units ?? metrics?.supplierKitUnits) || 0);
  return base + supplier;
}

/** В колонке «Поставщики» для комплекта: (N) — сколько комплектов из остатков поставщиков по составу. */
export function formatKitSupplierDisplay(product, directSupplierTotal = 0) {
  const raw = product?.kit_display ?? product?.kitDisplay;
  const fromApi =
    raw?.supplier_kit_units ??
    raw?.supplierKitUnits ??
    product?.supplierStockTotal ??
    product?.supplier_stock_total;
  const kitUnits = Math.max(0, Number(fromApi) || 0);
  const direct = Math.max(0, Number(directSupplierTotal) || 0);
  if (kitUnits > 0 && direct <= 0) return `(${kitUnits})`;
  return null;
}

/** Сколько комплектов в «в пути» из ожидания комплектующих (API или строки списка). */
export function kitIncomingFromComponentsAmount(metrics, product = null, allProducts = null) {
  const fromMetrics = Math.max(0, Number(metrics?.incoming_from_components) || 0);
  if (fromMetrics > 0) return fromMetrics;
  const fromProduct = Math.max(0, Number(product?.incoming_from_components ?? product?.incomingFromComponents) || 0);
  if (fromProduct > 0) return fromProduct;
  if (Array.isArray(allProducts) && product) {
    return computeKitIncomingFromLoadedProducts(product, allProducts);
  }
  return 0;
}

/** В пути для комплекта: ожидание SKU + собираемость из «в пути» комплектующих. */
export function kitTotalIncomingForDisplay(metrics, product, allProducts, baseIncoming = 0) {
  const fromComponents = kitIncomingFromComponentsAmount(metrics, product, allProducts);
  return Math.max(0, Number(baseIncoming) || 0) + fromComponents;
}

/** @deprecated Используйте kitTotalIncomingForDisplay */
export function formatKitIncomingDisplay(product, directIncoming = 0, allProducts = null) {
  const raw = product?.kit_display ?? product?.kitDisplay;
  const fromComponents = kitIncomingFromComponentsAmount(raw, product, allProducts);
  const direct = Math.max(0, Number(directIncoming) || 0);
  const total = direct + fromComponents;
  return total > 0 ? String(total) : null;
}

/** Сколько комплектов можно собрать из «в пути» комплектующих (строки того же списка). */
export function computeKitIncomingFromLoadedProducts(kitProduct, allProducts) {
  const comps = kitProduct?.kit_components;
  if (!Array.isArray(comps) || comps.length === 0) return 0;

  const byId = new Map((allProducts || []).map((p) => [String(p.id), p]));
  let minKits = Infinity;
  for (const c of comps) {
    const cid = c.productId ?? c.component_product_id;
    if (cid == null || cid === '') {
      minKits = 0;
      break;
    }
    const comp = byId.get(String(cid));
    if (!comp) {
      minKits = 0;
      break;
    }
    const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
    const onHand = Number(comp.quantity) || 0;
    const incoming = Number(comp.incoming_quantity ?? comp.incomingQuantity) || 0;
    const reserved = Number(comp.reserved_quantity ?? comp.reservedQuantity) || 0;
    const incomingOnly = Math.max(0, incoming - Math.max(0, reserved - onHand));
    minKits = Math.min(minKits, Math.floor(incomingOnly / perKit));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

/** Количество комплектующей на 1 комплект (из состава kit_components). */
export function kitComponentPerKitQty(kitProduct, componentProductId) {
  const cid = String(componentProductId ?? '');
  const comps = kitProduct?.kit_components ?? kitProduct?.kitComponents;
  if (!Array.isArray(comps)) return 1;
  const row = comps.find((c) => String(c.productId ?? c.component_product_id) === cid);
  return Math.max(1, parseInt(row?.quantity, 10) || 1);
}

function movementTypeLowerSimple(m) {
  const t = m?.type ?? m?.movement_type ?? m?.movementType;
  return t != null ? String(t).trim().toLowerCase() : '';
}

function parseMovementMetaSimple(m) {
  const raw = m?.meta;
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Снятие ожидания по закупке (уменьшение/удаление строки) — отдельная строка истории, не группировать с «ожидание». */
export function isPurchaseIncomingRemovalMovement(m) {
  if (!m || movementTypeLowerSimple(m) !== 'incoming') return false;
  const reason = String(m.reason || '');
  if (/снятие\s+ожидан/i.test(reason)) return true;
  const meta = parseMovementMetaSimple(m);
  if (meta.line_removed === true || meta.line_removed === 'true') return true;
  const qc = Number(m.quantity_change ?? m.quantityChange);
  return Number.isFinite(qc) && qc < 0;
}

/** Начисление «в пути» по закупке для комплекта (группировка комплектующих в одну строку). */
export function isKitPurchaseIncomingAddMovement(m, kitProduct = null) {
  if (!m || movementTypeLowerSimple(m) !== 'incoming') return false;
  if (isPurchaseIncomingRemovalMovement(m)) return false;
  const reason = String(m.reason || '');
  if (!/закупк/i.test(reason) || !/ожидан/i.test(reason)) return false;
  const meta = parseMovementMetaSimple(m);
  if (meta.kit_component_incoming === true || meta.kit_component_incoming === 'true') return true;
  if (!kitProduct) return false;
  const pid = String(m.product_id ?? m.productId ?? '');
  const kitId = String(kitProduct.id ?? '');
  if (pid && kitId && pid === kitId) return true;
  const comps = kitProduct.kit_components ?? kitProduct.kitComponents;
  return (
    Array.isArray(comps) &&
    comps.some((c) => String(c.productId ?? c.component_product_id) === pid)
  );
}

/**
 * Сколько комплектов «в пути» по одной закупке в истории:
 * целые SKU комплекта + min(⌊qty/perKit⌋) по комплектующим (сумма путей, не min по всем строкам).
 */
export function kitIncomingUnitsFromPurchaseMovements(movements, kitProduct) {
  if (!Array.isArray(movements) || movements.length === 0) return 0;
  const kitId = kitProduct?.id != null ? String(kitProduct.id) : null;
  let wholeKits = 0;
  const compQty = new Map();

  for (const m of movements) {
    const qtyAdded = Math.max(0, Number(m.quantity_change ?? m.quantityChange) || 0);
    if (qtyAdded <= 0) continue;
    const pid = String(m.product_id ?? m.productId ?? '');
    if (kitId && pid === kitId) {
      wholeKits += qtyAdded;
      continue;
    }
    if (pid) compQty.set(pid, (compQty.get(pid) || 0) + qtyAdded);
  }

  let minFromComponents = Infinity;
  for (const [pid, totalQty] of compQty) {
    const perKit = kitComponentPerKitQty(kitProduct, pid);
    minFromComponents = Math.min(minFromComponents, Math.floor(totalQty / perKit));
  }
  const fromComponents =
    Number.isFinite(minFromComponents) && minFromComponents !== Infinity
      ? Math.max(0, minFromComponents)
      : 0;

  return wholeKits + fromComponents;
}

/** Собираемость из комплектующих по строкам того же списка (если с API не пришёл kit_display). */
export function computeAssemblableFromLoadedProducts(kitProduct, allProducts) {
  const comps = kitProduct?.kit_components;
  if (!Array.isArray(comps) || comps.length === 0) return 0;

  const byId = new Map(
    (allProducts || []).map((p) => [String(p.id), p])
  );

  let minKits = Infinity;
  for (const c of comps) {
    const cid = c.productId ?? c.component_product_id;
    if (cid == null || cid === '') {
      minKits = 0;
      break;
    }
    const comp = byId.get(String(cid));
    if (!comp) {
      minKits = 0;
      break;
    }
    const perKit = Math.max(1, parseInt(c.quantity, 10) || 1);
    const onHand = Number(comp.quantity) || 0;
    const incoming = Number(comp.incoming_quantity ?? comp.incomingQuantity) || 0;
    const reserved = Number(comp.reserved_quantity ?? comp.reservedQuantity) || 0;
    const suppliers = Number(comp.supplierStockTotal ?? comp.supplier_stock_total) || 0;
    const avail = Math.max(0, onHand + incoming + suppliers - reserved);
    minKits = Math.min(minKits, Math.floor(avail / perKit));
  }
  return Number.isFinite(minKits) ? Math.max(0, minKits) : 0;
}

function buildKitDisplayFromProduct(product, baseMetrics, allProducts) {
  const fromApi = parseKitDisplayMetrics(product);
  if (fromApi) return fromApi;

  if (
    !isKitProduct(product) ||
    !Array.isArray(product.kit_components) ||
    product.kit_components.length === 0
  ) {
    return null;
  }

  const wholeOnHand = Math.max(0, Number(product.quantity) || 0);
  const assemblable = computeAssemblableFromLoadedProducts(product, allProducts);
  const incomingFromComponents = computeKitIncomingFromLoadedProducts(product, allProducts);
  const wholeAvailable = Math.max(
    0,
    wholeOnHand + (Number(baseMetrics.incoming) || 0) - (Number(baseMetrics.reserved) || 0)
  );
  return {
    whole_on_hand: wholeOnHand,
    whole_available: wholeAvailable,
    assemblable_from_components: assemblable,
    incoming_from_components: incomingFromComponents,
    marketplace_available: wholeAvailable + assemblable,
    available_total: wholeAvailable + assemblable
  };
}

/**
 * @param {object[]} products
 * @param {(product: object) => object} buildBaseMetrics — метрики обычного товара (не комплекта)
 */
export function buildStockRowsWithKits(products, buildBaseMetrics) {
  return products.map((product) => {
    if (!isKitProduct(product)) {
      return { product, ...buildBaseMetrics(product) };
    }

    const base = buildBaseMetrics(product);
    const display = buildKitDisplayFromProduct(product, base, products);

    if (display) {
      const onSkuReserved = Math.max(
        0,
        Number(display.reserved_on_sku ?? display.reservedOnSku) || 0
      );
      const displayReserved = Math.max(0, Number(base.reserved) || 0);
      const wholeAvailable =
        display.whole_available != null && !Number.isNaN(Number(display.whole_available))
          ? Math.max(0, Number(display.whole_available))
          : Math.max(
              0,
              (Number(display.whole_on_hand) || 0) + (Number(base.incoming) || 0) - onSkuReserved
            );
      const marketplaceAvailable =
        display.marketplace_available != null &&
        !Number.isNaN(Number(display.marketplace_available))
          ? Math.max(0, Number(display.marketplace_available))
          : Math.max(0, wholeAvailable + (Number(display.assemblable_from_components) || 0));
      const availableTotal = marketplaceAvailable;
      const suppliersDisplay = formatKitSupplierDisplay(product, base.suppliers);
      const incomingFromComponents = kitIncomingFromComponentsAmount(display, product, products);
      const kitMetrics = {
        ...display,
        whole_available: wholeAvailable,
        marketplace_available: marketplaceAvailable,
        available_total: availableTotal
      };
      return {
        product,
        onHand: Math.max(0, Number(display.whole_on_hand) || 0),
        incoming: Math.max(0, Number(base.incoming) || 0),
        incomingFromComponents: Math.max(0, incomingFromComponents),
        reserved: Math.max(0, Number(base.reserved) || 0),
        suppliers: suppliersDisplay ? 0 : base.suppliers,
        supplierDetails: base.supplierDetails,
        suppliersDisplay,
        available: marketplaceAvailable,
        availableDisplay: formatKitAvailableDisplay(kitMetrics, product)
      };
    }

    return {
      product,
      ...base,
      availableDisplay: String(base.available ?? 0)
    };
  });
}

/** Подпись «Доступно» для выбора товара (ручной заказ и т.п.) на выбранном складе. */
export function manualOrderAvailabilityLabel(product, products = [], { warehouseId = null } = {}) {
  if (!product?.id || warehouseId == null || String(warehouseId).trim() === '') return null;
  const list = Array.isArray(products) ? products : [];
  const catalog = list.some((p) => String(p.id) === String(product.id)) ? list : [...list, product];
  const rows = buildStockRowsWithKits(catalog, (p) => {
    const onHand = Number(p.quantity ?? 0) || 0;
    const incoming = Number(p.incoming_quantity ?? p.incomingQuantity ?? 0) || 0;
    const reserved = Math.max(
      0,
      Number(
        p.net_reserved_quantity ??
          p.netReservedQuantity ??
          p.reserved_quantity ??
          p.reservedQuantity ??
          0
      ) || 0
    );
    const available = stockTableAvailable({ onHand, incoming, reserved, suppliers: 0 });
    return { onHand, incoming, reserved, suppliers: 0, available };
  });
  const row = rows.find((r) => String(r.product.id) === String(product.id));
  if (!row) return '—';
  if (isKitProduct(product)) {
    return row.availableDisplay ?? String(Math.max(0, Number(row.available) || 0));
  }
  return String(Math.max(0, Number(row.available) || 0));
}
