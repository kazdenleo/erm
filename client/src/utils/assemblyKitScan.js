/**
 * Логика скан-сборки комплектов (чистые функции для UI и тестов).
 */

/** Скан штрихкода SKU целого комплекта / подкомплекта (не отдельной комплектующей). */
export function isKitSkuScanForOrder(product, orderItems) {
  if (!product?.id || !orderItems?.length) return false;
  const scanId = String(product.id);

  const isSubKitScan = orderItems.some(
    (item) => String(item.subKitProductId ?? item.sub_kit_product_id ?? '') === scanId
  );
  const isWholeLineScan = orderItems.some((item) => {
    const linePid = String(item.productId ?? item.product_id ?? '');
    return linePid === scanId && (item.isKitWhole || item.isSubKitWhole);
  });

  if (!isSubKitScan && !isWholeLineScan) return false;

  if (
    orderItems.length === 1 &&
    !orderItems[0].isKitComponent &&
    !orderItems[0].isSubKitWhole
  ) {
    const linePid = String(orderItems[0].productId ?? orderItems[0].product_id ?? '');
    if (linePid === scanId && !isWholeLineScan) return false;
  }
  return true;
}

/** Какие строки состава закрыть при скане SKU комплекта / подкомплекта. */
export function assemblyLinesToCompleteOnKitScan(product, orderItems) {
  if (!product?.id || !orderItems?.length) return new Set();
  const scanId = String(product.id);
  const isSubKitScan = orderItems.some(
    (item) => String(item.subKitProductId ?? item.sub_kit_product_id ?? '') === scanId
  );
  const keys = new Set();
  orderItems.forEach((item, idx) => {
    if (isSubKitScan) {
      const subKit = String(item.subKitProductId ?? item.sub_kit_product_id ?? '');
      const linePid = String(item.productId ?? item.product_id ?? '');
      if (subKit === scanId || (linePid === scanId && item.isSubKitWhole)) {
        keys.add(idx);
      }
    } else {
      const linePid = String(item.productId ?? item.product_id ?? '');
      if (linePid === scanId && (item.isKitWhole || item.isSubKitWhole)) {
        keys.add(idx);
      }
    }
  });
  return keys;
}

/** Совпадение скана с одной строкой состава (product_id строки — комплектующая). */
export function orderItemMatchesScannedProduct(item, product) {
  if (!product?.id) return false;
  const target = Number(product.id);
  const raw = item.productId ?? item.product_id;
  if (raw != null && raw !== '') {
    const linePid = Number(raw);
    if (!Number.isNaN(target) && !Number.isNaN(linePid) && linePid === target) return true;
    if (String(raw) === String(product.id)) return true;
  }
  return false;
}
