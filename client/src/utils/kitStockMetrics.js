/**
 * Таблица «Остатки на складе» — единая семантика для товара и комплекта:
 *
 * У комплекта с **kit_stock_split** в колонках **Наличие / В пути / Резерв / Поставщики** — формат **слева / справа**:
 * - **Слева** — целые комплекты по SKU комплекта (не дублирует пересчёт из комплектующих; если на складе только детали — `0`).
 * - **Справа** — сколько полных комплектов дают комплектующие: min по наличию, в пути, резерву и у поставщиков.
 *
 * «Доступно» — сумма слагаемых по наличию, в пути и поставщикам (слева + справа по каждой оси), минус суммарный
 * резерв (слева + справа), не ниже нуля.
 *
 * Без **kit_stock_split**: у комплекта в «В пути» **0**, ожидание по деталям только в «Доступно»; метрики по
 * комплектующим на клиенте — только если комплектующие есть в том же списке товаров.
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
  return String(product?.product_type || '').toLowerCase() === 'kit';
}

/** @returns {null|{ whole_on_hand: number, from_components_on_hand: number, whole_incoming: number, from_components_incoming: number, whole_reserved: number, from_components_reserved: number, whole_suppliers: number, from_components_suppliers: number }} */
export function parseKitStockSplit(product) {
  const raw = product?.kit_stock_split ?? product?.kitStockSplit;
  if (!raw || typeof raw !== 'object') return null;
  const n = (snake, camel) => Math.max(0, Number(raw[snake] ?? raw[camel]) || 0);
  return {
    whole_on_hand: n('whole_on_hand', 'wholeOnHand'),
    from_components_on_hand: n('from_components_on_hand', 'fromComponentsOnHand'),
    whole_incoming: n('whole_incoming', 'wholeIncoming'),
    from_components_incoming: n('from_components_incoming', 'fromComponentsIncoming'),
    whole_reserved: n('whole_reserved', 'wholeReserved'),
    from_components_reserved: n('from_components_reserved', 'fromComponentsReserved'),
    whole_suppliers: n('whole_suppliers', 'wholeSuppliers'),
    from_components_suppliers: n('from_components_suppliers', 'fromComponentsSuppliers')
  };
}

/**
 * Сколько полных комплектов даёт метрика по комплектующим (min floor).
 * @param {'onHand'|'incoming'|'suppliers'} metricKey
 * @returns {{ ok: boolean, value: number }}
 */
function minKitsFromComponentMetrics(product, metricsByProductId, metricKey) {
  const components = Array.isArray(product?.kit_components) ? product.kit_components : [];
  if (components.length === 0) return { ok: false, value: 0 };

  let minK = Infinity;
  for (const comp of components) {
    const compId = String(comp.productId ?? comp.component_product_id ?? '').trim();
    const perKit = Math.max(1, Number(comp.quantity) || 1);
    const m = metricsByProductId.get(compId);
    if (!m) return { ok: false, value: 0 };
    const raw = Number(m[metricKey]) || 0;
    minK = Math.min(minK, Math.floor(raw / perKit));
  }
  const value = Number.isFinite(minK) ? Math.max(0, minK) : 0;
  return { ok: true, value };
}

/**
 * @param {object} product
 * @param {object} base — onHand, incoming, reserved, suppliers, supplierDetails, available
 * @param {Map<string, object>} metricsByProductId
 */
export function computeKitStockMetrics(product, metricsByProductId) {
  const components = Array.isArray(product?.kit_components) ? product.kit_components : [];
  if (components.length === 0) {
    const reserved = Number(product?.reserved_quantity ?? product?.reservedQuantity ?? 0) || 0;
    return {
      onHand: 0,
      incoming: 0,
      reserved,
      suppliers: 0,
      supplierDetails: [],
      available: stockTableAvailable({ onHand: 0, incoming: 0, reserved, suppliers: 0 })
    };
  }

  const rOn = minKitsFromComponentMetrics(product, metricsByProductId, 'onHand');
  const rIn = minKitsFromComponentMetrics(product, metricsByProductId, 'incoming');
  const rSup = minKitsFromComponentMetrics(product, metricsByProductId, 'suppliers');
  if (!rOn.ok || !rIn.ok || !rSup.ok) {
    const reserved = Number(product?.reserved_quantity ?? product?.reservedQuantity ?? 0) || 0;
    return {
      onHand: 0,
      incoming: 0,
      reserved,
      suppliers: 0,
      supplierDetails: [],
      available: stockTableAvailable({ onHand: 0, incoming: 0, reserved, suppliers: 0 })
    };
  }

  const onHand = rOn.value;
  const incomingKitsFromComponents = rIn.value;
  const suppliers = rSup.value;
  const reserved = Number(product?.reserved_quantity ?? product?.reservedQuantity ?? 0) || 0;
  const available = stockTableAvailable({
    onHand,
    incoming: incomingKitsFromComponents,
    reserved,
    suppliers
  });

  return {
    onHand,
    incoming: 0,
    reserved,
    suppliers,
    supplierDetails: [],
    available
  };
}

/**
 * @param {object[]} products
 * @param {(product: object) => object} buildBaseMetrics — метрики обычного товара (не комплекта)
 */
export function buildStockRowsWithKits(products, buildBaseMetrics) {
  const metricsByProductId = new Map();

  for (const product of products) {
    if (isKitProduct(product)) continue;
    const id = String(product.id ?? '');
    if (!id) continue;
    metricsByProductId.set(id, buildBaseMetrics(product));
  }

  return products.map((product) => {
    const split = isKitProduct(product) ? parseKitStockSplit(product) : null;
    const comps = Array.isArray(product?.kit_components) ? product.kit_components : [];
    if (split && comps.length > 0) {
      const reserved = split.whole_reserved + split.from_components_reserved;
      const onHand = split.whole_on_hand + split.from_components_on_hand;
      const incoming = split.whole_incoming + split.from_components_incoming;
      const suppliers = split.whole_suppliers + split.from_components_suppliers;
      return {
        product,
        onHand,
        onHandDisplay: `${split.whole_on_hand} / ${split.from_components_on_hand}`,
        incoming,
        incomingDisplay: `${split.whole_incoming} / ${split.from_components_incoming}`,
        reserved,
        reservedDisplay: `${split.whole_reserved} / ${split.from_components_reserved}`,
        suppliers,
        suppliersDisplay: `${split.whole_suppliers} / ${split.from_components_suppliers}`,
        supplierDetails: [],
        available: stockTableAvailable({ onHand, incoming, reserved, suppliers })
      };
    }

    if (isKitProduct(product) && (product.kit_stock_persisted || !product.kit_quantity_derived)) {
      const onHand = Number(product.quantity ?? 0) || 0;
      const reserved =
        Number(product.reserved_quantity ?? product.reservedQuantity ?? 0) || 0;
      const comps = Array.isArray(product.kit_components) ? product.kit_components : [];
      const rIn = comps.length > 0 ? minKitsFromComponentMetrics(product, metricsByProductId, 'incoming') : null;
      const rSup = comps.length > 0 ? minKitsFromComponentMetrics(product, metricsByProductId, 'suppliers') : null;
      const incomingKitsFromComponents =
        rIn && rIn.ok ? rIn.value : comps.length > 0 ? 0 : Number(product.incoming_quantity ?? product.incomingQuantity ?? 0) || 0;
      const suppliers =
        rSup && rSup.ok
          ? rSup.value
          : Number(product.supplierStockTotal ?? 0) || 0;
      const available = stockTableAvailable({
        onHand,
        incoming: incomingKitsFromComponents,
        reserved,
        suppliers
      });
      return {
        product,
        onHand,
        incoming: 0,
        reserved,
        suppliers,
        supplierDetails: [],
        available
      };
    }
    if (isKitProduct(product)) {
      const kitMetrics = computeKitStockMetrics(product, metricsByProductId);
      return { product, ...kitMetrics };
    }
    const id = String(product.id ?? '');
    const base =
      metricsByProductId.get(id) ||
      buildBaseMetrics(product);
    return { product, ...base };
  });
}
