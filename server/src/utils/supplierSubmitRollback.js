/**
 * Правила отката локальной закупки после ответа API поставщика.
 * Успешно принятые позиции (Basket_Add и т.п.) не откатываем — иначе антидубль
 * теряет покрытие и автозакупка снова шлёт тот же SKU в корзину поставщика.
 */

export function supplierSubmitNeedsRollback(supplierSubmit, { apiSubmitRequired = false } = {}) {
  if (!apiSubmitRequired) return false;
  if (!supplierSubmit || supplierSubmit.skipped) return false;
  if (supplierSubmit.reason === 'already_submitted') return false;
  // Таймаут/сеть после возможного Basket_Add — локальную строку оставляем (антидубль).
  if (supplierSubmit.ambiguousSuccess) return false;

  const accepted =
    Array.isArray(supplierSubmit.lines) && supplierSubmit.lines.length > 0;
  if (accepted) {
    // Откатываем только явно отвергнутые позиции.
    return (
      Array.isArray(supplierSubmit.failedLines) && supplierSubmit.failedLines.length > 0
    );
  }

  if (supplierSubmit.submitted === true && !supplierSubmit.partial) return false;
  if (supplierSubmit.submitted !== true) return true;
  return Boolean(supplierSubmit.partial && Array.isArray(supplierSubmit.failedLines));
}

/** Какие позиции батча убрать из локальной закупки при откате. */
export function rollbackItemsForSupplierSubmit(itemsToProcess, supplierSubmit) {
  const items = Array.isArray(itemsToProcess) ? itemsToProcess : [];
  if (!items.length) return [];

  const failed = Array.isArray(supplierSubmit?.failedLines) ? supplierSubmit.failedLines : [];
  if (failed.length > 0) {
    const failedIds = new Set(
      failed.map((l) => Number(l.productId)).filter((id) => Number.isFinite(id) && id > 0)
    );
    return items.filter((it) => failedIds.has(Number(it.productId)));
  }

  // Есть принятые поставщиком строки — полный откат запрещён.
  if (Array.isArray(supplierSubmit?.lines) && supplierSubmit.lines.length > 0) {
    return [];
  }

  return items;
}

/** ID позиций корзины поставщика, которые нужно снять при откате этих productId. */
export function basketItemIdsForRollback(supplierSubmit, rollbackItems) {
  const rollbackProductIds = new Set(
    (rollbackItems || [])
      .map((it) => Number(it?.productId ?? it?.product_id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );
  if (!rollbackProductIds.size) return [];

  const ids = [];
  const seen = new Set();
  for (const line of supplierSubmit?.lines || []) {
    const productId = Number(line?.productId ?? line?.product_id);
    if (!rollbackProductIds.has(productId)) continue;
    const bid = Number(line?.basketItemId ?? line?.supplierBasketItemId ?? line?.supplierOrderId);
    if (!Number.isFinite(bid) || bid < 1 || seen.has(bid)) continue;
    seen.add(bid);
    ids.push(bid);
  }
  return ids;
}
