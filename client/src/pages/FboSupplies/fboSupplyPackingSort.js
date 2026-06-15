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

/** Вкладка «Общее»: сначала строки с покрытием, затем со складом без покрытия, остальные. */
export function sortSupplyItemsForGeneral(items) {
  const list = [...(items || [])];
  return list.sort((a, b) => {
    const covA =
      (Number(a.reservedFromStock ?? a.reserved_from_stock) || 0) +
      (Number(a.reservedFromIncoming ?? a.reserved_from_incoming) || 0);
    const covB =
      (Number(b.reservedFromStock ?? b.reserved_from_stock) || 0) +
      (Number(b.reservedFromIncoming ?? b.reserved_from_incoming) || 0);
    const onHandA = Number(a.sourceOnHand ?? a.source_on_hand) || 0;
    const onHandB = Number(b.sourceOnHand ?? b.source_on_hand) || 0;
    const incA = Number(a.sourceIncoming ?? a.source_incoming) || 0;
    const incB = Number(b.sourceIncoming ?? b.source_incoming) || 0;

    const tier = (cov, onHand, inc) => {
      if (cov > 0) return 0;
      if (onHand > 0 || inc > 0) return 1;
      return 2;
    };
    const tA = tier(covA, onHandA, incA);
    const tB = tier(covB, onHandB, incB);
    if (tA !== tB) return tA - tB;
    if (covB !== covA) return covB - covA;
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
