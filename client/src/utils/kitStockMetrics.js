/**
 * Комплекты в таблице «Остатки на складе»:
 *
 * - Движения (резерв, отгрузка, поступление) — только по SKU комплекта, как у обычного товара.
 * - Наличие / в пути / поставщики — по карточке комплекта (1 SKU); резерв — на SKU или сумма по комплектующим.
 * - Доступно: слева — целые комплекты к продаже (наличие + в пути − резерв); в скобках — целые + собираемость из комплектующих (на МП).
 *   Пример: 1 (8) — 1 целый комплект; всего к продаже 1 целый + 7 из деталей = 8.
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

/** Типы движений в истории остатков комплекта (SKU + резерв / «в пути»). */
export const KIT_STOCK_HISTORY_MOVEMENT_TYPES = [
  'receipt',
  'shipment',
  'writeoff',
  'inventory',
  'manual',
  'transfer',
  'opening_balance',
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
    assemblable_from_components: assemblable,
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

/** В скобках: целые к продаже + собираемость из комплектующих. */
export function kitSellableTotalFromMetrics(metrics, product = null) {
  if (!metrics) return 0;
  if (metrics.marketplace_available != null && !Number.isNaN(Number(metrics.marketplace_available))) {
    return Math.max(0, Number(metrics.marketplace_available));
  }
  const wholeAvail = kitWholeAvailableFromMetrics(metrics, product);
  const assemblable = Math.max(0, Number(metrics.assemblable_from_components) || 0);
  return wholeAvail + assemblable;
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
  const wholeAvailable = Math.max(
    0,
    wholeOnHand + (Number(baseMetrics.incoming) || 0) - (Number(baseMetrics.reserved) || 0)
  );
  return {
    whole_on_hand: wholeOnHand,
    whole_available: wholeAvailable,
    assemblable_from_components: assemblable,
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
      const wholeAvailable = Math.max(
        0,
        (Number(display.whole_on_hand) || 0) + (Number(base.incoming) || 0) - (Number(base.reserved) || 0)
      );
      const marketplaceAvailable = wholeAvailable + display.assemblable_from_components;
      const availableTotal = marketplaceAvailable;
      const suppliersDisplay = formatKitSupplierDisplay(product, base.suppliers);
      const kitMetrics = {
        ...display,
        whole_available: wholeAvailable,
        marketplace_available: marketplaceAvailable,
        available_total: availableTotal
      };
      return {
        product,
        onHand: display.whole_on_hand,
        incoming: base.incoming,
        reserved: base.reserved,
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
