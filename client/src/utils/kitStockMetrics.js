/**
 * Комплекты в таблице «Остатки на складе»:
 *
 * - Движения (резерв, отгрузка, поступление) — только по SKU комплекта, как у обычного товара.
 * - Наличие / в пути / поставщики — по карточке комплекта (1 SKU); резерв — на SKU или сумма по комплектующим.
 * - Доступно — «собрать из комплектующих» + доступно по SKU комплекта; в скобках — целые комплекты на складе.
 *   Пример: 7 (2) — из деталей можно 5, на складе 2 шт. комплектом, всего доступно 7.
 */

/** В таблице «Остатки на складе»: наличие + в пути + у поставщиков − резерв (не ниже 0). */
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

/** Типы движений в истории остатков комплекта (только факт по SKU комплекта). */
export const KIT_STOCK_HISTORY_MOVEMENT_TYPES = [
  'receipt',
  'shipment',
  'writeoff',
  'inventory',
  'manual',
  'transfer',
  'opening_balance'
];

export function isKitStockHistoryMovementType(type) {
  return KIT_STOCK_HISTORY_MOVEMENT_TYPES.includes(String(type || '').toLowerCase());
}

export function isKitStockHistoryMovement(movement, product) {
  if (!isKitProduct(product)) return true;
  const t = movement?.type ?? movement?.movement_type ?? movement?.movementType;
  return isKitStockHistoryMovementType(t);
}

/** @returns {null|{ whole_on_hand: number, assemblable_from_components: number, available_total: number }} */
export function parseKitDisplayMetrics(product) {
  const raw = product?.kit_display ?? product?.kitDisplay ?? product?.kit_stock_split ?? product?.kitStockSplit;
  if (!raw || typeof raw !== 'object') return null;
  const n = (snake, camel) => Math.max(0, Number(raw[snake] ?? raw[camel]) || 0);
  const wholeOnHand = n('whole_on_hand', 'wholeOnHand');
  const assemblable = n('assemblable_from_components', 'assemblableFromComponents');
  const availableTotal =
    raw.available_total != null || raw.availableTotal != null
      ? n('available_total', 'availableTotal')
      : assemblable + wholeOnHand;
  return {
    whole_on_hand: wholeOnHand,
    assemblable_from_components: assemblable,
    available_total: availableTotal
  };
}

export function formatKitAvailableDisplay(metrics) {
  if (!metrics) return null;
  const total = Math.max(0, Number(metrics.available_total) || 0);
  const whole = Math.max(0, Number(metrics.whole_on_hand) || 0);
  return `${total} (${whole})`;
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
    assemblable_from_components: assemblable,
    available_total: assemblable + wholeAvailable
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
      const availableTotal = display.assemblable_from_components + wholeAvailable;
      const suppliersDisplay = formatKitSupplierDisplay(product, base.suppliers);
      return {
        product,
        onHand: display.whole_on_hand,
        incoming: base.incoming,
        reserved: base.reserved,
        suppliers: suppliersDisplay ? 0 : base.suppliers,
        supplierDetails: base.supplierDetails,
        suppliersDisplay,
        available: availableTotal,
        availableDisplay: formatKitAvailableDisplay({
          ...display,
          available_total: availableTotal
        })
      };
    }

    return {
      product,
      ...base,
      availableDisplay: String(base.available ?? 0)
    };
  });
}
