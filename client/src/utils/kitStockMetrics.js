/**
 * Остатки комплекта = минимум по комплектующим: floor(остаток_комплектующего / qty_в_комплекте).
 */

export function isKitProduct(product) {
  return String(product?.product_type || '').toLowerCase() === 'kit';
}

/**
 * @param {object} product
 * @param {object} base — onHand, incoming, reserved, suppliers, supplierDetails, available
 * @param {Map<string, object>} metricsByProductId
 */
export function computeKitStockMetrics(product, metricsByProductId) {
  const components = Array.isArray(product?.kit_components) ? product.kit_components : [];
  if (components.length === 0) {
    return {
      onHand: 0,
      incoming: 0,
      reserved: Number(product?.reserved_quantity ?? product?.reservedQuantity ?? 0) || 0,
      suppliers: 0,
      supplierDetails: [],
      available: 0
    };
  }

  let minOnHand = Infinity;
  let minIncoming = Infinity;
  let minSuppliers = Infinity;

  for (const comp of components) {
    const compId = String(comp.productId ?? comp.component_product_id ?? '').trim();
    const perKit = Math.max(1, Number(comp.quantity) || 1);
    const m = metricsByProductId.get(compId);
    if (!m) {
      return {
        onHand: 0,
        incoming: 0,
        reserved: Number(product?.reserved_quantity ?? product?.reservedQuantity ?? 0) || 0,
        suppliers: 0,
        supplierDetails: [],
        available: 0
      };
    }
    minOnHand = Math.min(minOnHand, Math.floor((Number(m.onHand) || 0) / perKit));
    minIncoming = Math.min(minIncoming, Math.floor((Number(m.incoming) || 0) / perKit));
    minSuppliers = Math.min(minSuppliers, Math.floor((Number(m.suppliers) || 0) / perKit));
  }

  const onHand = Number.isFinite(minOnHand) ? Math.max(0, minOnHand) : 0;
  const incoming = Number.isFinite(minIncoming) ? Math.max(0, minIncoming) : 0;
  const suppliers = Number.isFinite(minSuppliers) ? Math.max(0, minSuppliers) : 0;
  const reserved = Number(product?.reserved_quantity ?? product?.reservedQuantity ?? 0) || 0;
  const available = onHand + suppliers;

  return { onHand, incoming, reserved, suppliers, supplierDetails: [], available };
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
    if (isKitProduct(product) && product.kit_quantity_derived) {
      const onHand = Number(product.quantity ?? 0) || 0;
      const suppliers = Number(product.supplierStockTotal ?? 0) || 0;
      const reserved =
        Number(product.reserved_quantity ?? product.reservedQuantity ?? 0) || 0;
      const incoming =
        Number(product.incoming_quantity ?? product.incomingQuantity ?? 0) || 0;
      return {
        product,
        onHand,
        incoming,
        reserved,
        suppliers,
        supplierDetails: [],
        available: onHand + suppliers
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
