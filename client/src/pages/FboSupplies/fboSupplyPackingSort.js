/**
 * Сортировка строк поставки для сборки: неполные сверху, собранные (план = факт) внизу.
 */

export function isSupplyItemPackingComplete(stat, item) {
  const planned = stat?.planned ?? item?.quantity ?? 0;
  const packed = stat?.packed ?? 0;
  return packed === planned;
}

export function sortSupplyItemsForPacking(items, statsByItemId) {
  const list = [...(items || [])];
  return list.sort((a, b) => {
    const statA = statsByItemId?.get?.(String(a.id));
    const statB = statsByItemId?.get?.(String(b.id));
    const doneA = isSupplyItemPackingComplete(statA, a);
    const doneB = isSupplyItemPackingComplete(statB, b);
    if (doneA !== doneB) return doneA ? 1 : -1;
    return Number(a.id) - Number(b.id);
  });
}

export function buildStatsMap(itemStats) {
  const map = new Map();
  for (const s of itemStats || []) {
    map.set(String(s.supplyItemId), s);
  }
  return map;
}
