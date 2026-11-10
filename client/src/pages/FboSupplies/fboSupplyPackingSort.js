/**
 * Сортировка строк поставки для сборки: неполные сверху, собранные (план = факт) внизу.
 */

import { getFboItemReserveParts } from './fboSupplyItemReserve.js';

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

/**
 * Вкладка «Общее»: без резерва → в пути → в наличии.
 * Смешанные строки: любой gap → «без резерва»; иначе любой путь → «в пути»; иначе наличие.
 */
export function generalItemReserveTier(item) {
  const { stock, incoming, unreserved } = getFboItemReserveParts(item);
  if (unreserved > 0) return 0;
  if (incoming > 0) return 1;
  if (stock > 0) return 2;
  return 3;
}

export function sortSupplyItemsForGeneral(items) {
  const list = [...(items || [])];
  return list.sort((a, b) => {
    const tA = generalItemReserveTier(a);
    const tB = generalItemReserveTier(b);
    if (tA !== tB) return tA - tB;
    const partsA = getFboItemReserveParts(a);
    const partsB = getFboItemReserveParts(b);
    if (tA === 0 && partsB.unreserved !== partsA.unreserved) {
      return partsB.unreserved - partsA.unreserved;
    }
    if (tA === 1 && partsB.incoming !== partsA.incoming) {
      return partsB.incoming - partsA.incoming;
    }
    if (tA === 2 && partsB.stock !== partsA.stock) {
      return partsB.stock - partsA.stock;
    }
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
