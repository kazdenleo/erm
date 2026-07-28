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

/** Скан штрихкода корневого SKU комплекта при строках-составляющих в orderItems. */
export function isRootKitSkuScanForOrder(product, orderItems) {
  if (!product?.id || !orderItems?.length) return false;
  const scanId = String(product.id);
  return orderItems.some(
    (item) => String(item.kitProductId ?? item.kit_product_id ?? '') === scanId
  );
}

/** Закрыть все строки одного комплекта при скане его SKU. */
export function assemblyLinesToCompleteOnRootKitScan(product, orderItems) {
  if (!product?.id || !orderItems?.length) return new Set();
  const scanId = String(product.id);
  const keys = new Set();
  orderItems.forEach((item, idx) => {
    if (String(item.kitProductId ?? item.kit_product_id ?? '') === scanId) {
      keys.add(idx);
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

/**
 * Стабильный ключ строки для счётчика сканов.
 * Не зависит от orderLineId / порядка строк в ответе API — иначе при скане 2-й
 * комплектующей (другая строка заказа / другой shape) прогресс 1-й сбрасывался.
 */
export function assemblyLineScanKey(item, idx, items = null) {
  const pid = String(item?.productId ?? item?.product_id ?? '');
  const list = Array.isArray(items) ? items : null;
  let occ = 0;
  if (list) {
    for (let i = 0; i < idx; i += 1) {
      const p = String(list[i]?.productId ?? list[i]?.product_id ?? '');
      if (p === pid) occ += 1;
    }
  } else {
    occ = Number.isFinite(Number(idx)) ? Number(idx) : 0;
  }
  return `asm:pid:${pid}:${occ}`;
}

export function scannedQtyForAssemblyLine(item, idx, scannedQuantities, items = []) {
  const list = Array.isArray(items) ? items : [];
  const key = assemblyLineScanKey(item, idx, list);
  const fromKey = scannedQuantities?.[key];
  if (fromKey != null) return fromKey;
  if (list.length === 1) {
    const pid = item?.productId ?? item?.product_id;
    if (pid != null && pid !== '') {
      return scannedQuantities?.[pid] ?? scannedQuantities?.[Number(pid)] ?? 0;
    }
  }
  return 0;
}

/** Применить один скан штрихкода к счётчикам состава (та же логика, что на странице сборки). */
export function applyAssemblyBarcodeScan(prevQuantities, product, orderItems) {
  const next = { ...(prevQuantities || {}) };
  const items = Array.isArray(orderItems) ? orderItems : [];
  if (!product?.id || items.length === 0) return next;

  const setLineNeed = (item, idx) => {
    const need = item.quantity ?? 1;
    next[assemblyLineScanKey(item, idx, items)] = need;
  };

  if (isKitSkuScanForOrder(product, items)) {
    for (const idx of assemblyLinesToCompleteOnKitScan(product, items)) {
      setLineNeed(items[idx], idx);
    }
    return next;
  }

  if (isRootKitSkuScanForOrder(product, items)) {
    for (const idx of assemblyLinesToCompleteOnRootKitScan(product, items)) {
      setLineNeed(items[idx], idx);
    }
    return next;
  }

  const candidates = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => orderItemMatchesScannedProduct(item, product));

  const bumpLine = (item, idx) => {
    const key = assemblyLineScanKey(item, idx, items);
    next[key] = (next[key] || 0) + 1;
  };

  if (candidates.length === 0) {
    const legacySingleLine =
      items.length === 1 &&
      items[0].productId == null &&
      items[0].product_id == null;
    if (legacySingleLine) {
      bumpLine(items[0], 0);
    }
    return next;
  }

  for (const { item, idx } of candidates) {
    const need = item.quantity ?? 1;
    const key = assemblyLineScanKey(item, idx, items);
    const got = next[key] ?? 0;
    if (got < need) {
      bumpLine(item, idx);
      return next;
    }
  }
  const { item, idx } = candidates[candidates.length - 1];
  bumpLine(item, idx);
  return next;
}

/** Все ли строки состава закрыты по счётчикам сканов. */
export function isAssemblyCompositionComplete(orderItems, scannedQuantities) {
  const items = Array.isArray(orderItems) ? orderItems : [];
  if (!items.length) return false;
  return items.every((item, idx) => {
    const need = item.quantity ?? 1;
    const scanned = scannedQtyForAssemblyLine(item, idx, scannedQuantities, items);
    return scanned >= need;
  });
}

/**
 * Нужен ли ещё этот штрихкод на текущем заказе (есть незакрытая строка / скан комплекта).
 * Используется, чтобы не переключаться на другой заказ с тем же SKU при частичном прогрессе.
 */
export function scannedProductStillNeededOnOrder(product, orderItems, scannedQuantities) {
  const items = Array.isArray(orderItems) ? orderItems : [];
  if (!product?.id || !items.length) return false;
  if (isAssemblyCompositionComplete(items, scannedQuantities)) return false;

  if (isKitSkuScanForOrder(product, items) || isRootKitSkuScanForOrder(product, items)) {
    return true;
  }

  const candidates = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => orderItemMatchesScannedProduct(item, product));

  for (const { item, idx } of candidates) {
    const need = item.quantity ?? 1;
    const got = scannedQtyForAssemblyLine(item, idx, scannedQuantities || {}, items);
    if (got < need) return true;
  }
  return false;
}

/**
 * Решение UI: остаться на текущем заказе A при скане, который также есть на B.
 * true — продолжать A; false — можно переключаться (A не нуждается в скане).
 */
export function shouldPreferCurrentAssemblyOrder(product, currentOrderItems, scannedQuantities) {
  return scannedProductStillNeededOnOrder(product, currentOrderItems, scannedQuantities);
}
