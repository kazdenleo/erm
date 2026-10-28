function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isUnifiedPriceBlock(errorText) {
  const text = String(errorText || '');
  return /unified price logic/i.test(text) || /"code"\s*:\s*9/.test(text);
}

/**
 * Цена, при которой товар выходит из эластичного/максимального бустинга.
 * Ozon снимает товар, если предельная цена не ниже порога акции (max_action_price).
 * Берём обычную цену товара, если она уже выше порога — так потолок продажи не опускается.
 */
export function exitActionPrice(row) {
  const current = num(row?.price);
  const floor = num(row?.floor);
  const cap = num(row?.maxActionPrice ?? row?.max_action_price);
  const limit = cap != null && cap > 0 ? cap : null;
  if (current != null && current > 0 && (limit == null || current >= limit)) return Math.round(current);
  if (floor != null && floor > 0 && (limit == null || floor >= limit)) return Math.round(floor);
  return limit != null ? Math.floor(limit) + 1 : null;
}

/**
 * Цена восстановления после выхода: продажная ERP → пол → текущая/list.
 * Затем guard порога акции (exitActionPrice), чтобы товар реально снялся.
 */
export function restoreExitPrice(row) {
  const selling = num(row?.selling_price ?? row?.sellingPrice);
  const floor = num(row?.floor);
  const list = num(row?.list_price ?? row?.price);
  const preferred =
    selling != null && selling > 0
      ? selling
      : floor != null && floor > 0
        ? floor
        : list != null && list > 0
          ? list
          : null;
  return exitActionPrice({
    price: preferred,
    floor,
    max_action_price: row?.max_action_price ?? row?.maxActionPrice,
  });
}
