/**
 * Комплекты в таблице «Остатки на складе»:
 *
 * - Движения (резерв, отгрузка, поступление) — только по SKU комплекта, как у обычного товара.
 * - Наличие / в пути / резерв / поставщики — только по карточке комплекта (1 SKU).
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
  return String(product?.product_type || '').toLowerCase() === 'kit';
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

/**
 * @param {object[]} products
 * @param {(product: object) => object} buildBaseMetrics — метрики обычного товара (не комплекта)
 */
export function buildStockRowsWithKits(products, buildBaseMetrics) {
  return products.map((product) => {
    if (!isKitProduct(product)) {
      return { product, ...buildBaseMetrics(product) };
    }

    const display = parseKitDisplayMetrics(product);
    const base = buildBaseMetrics(product);

    if (display) {
      const wholeAvailable = stockTableAvailable({
        onHand: display.whole_on_hand,
        incoming: base.incoming,
        reserved: base.reserved,
        suppliers: base.suppliers
      });
      const availableTotal = display.assemblable_from_components + wholeAvailable;
      return {
        product,
        onHand: display.whole_on_hand,
        incoming: base.incoming,
        reserved: base.reserved,
        suppliers: base.suppliers,
        supplierDetails: base.supplierDetails,
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
