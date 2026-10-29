/**
 * Общее ранжирование поставщиков для закупки (ручная «В закупку» и автозаказ).
 * Порядок: цена с учётом надёжности → delivery_days → плановая дата прихода → isPriority → остаток.
 */

import { plannedDeliveryYmdForSupplier } from './supplierProcurementArrival.js';
import { effectiveProcurementPrice } from './supplierReliability.js';

/**
 * @param {Array<{
 *   price?: number|null,
 *   deliveryDays?: number,
 *   stock?: number|null,
 *   isPriority?: boolean,
 *   reliability?: number|null,
 *   apiConfig?: object,
 *   code?: string|null,
 * }>} candidates
 * @param {{ now?: Date, warehouseWeekendDays?: number[]|null }} [opts]
 */
export function sortSupplierCandidatesByProcurementRules(
  candidates,
  { now = new Date(), warehouseWeekendDays = null } = {}
) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  list.sort((a, b) => {
    const pa = effectiveProcurementPrice(a.price, a.reliability);
    const pb = effectiveProcurementPrice(b.price, b.reliability);
    if (pa !== pb) return pa - pb;

    const da = Number(a.deliveryDays) || 0;
    const db = Number(b.deliveryDays) || 0;
    if (da !== db) return da - db;

    const arrivalA = plannedDeliveryYmdForSupplier(a.apiConfig, {
      now,
      deliveryDays: da,
      warehouseWeekendDays,
      supplierCode: a.code,
    });
    const arrivalB = plannedDeliveryYmdForSupplier(b.apiConfig, {
      now,
      deliveryDays: db,
      warehouseWeekendDays,
      supplierCode: b.code,
    });
    if (arrivalA !== arrivalB) return arrivalA.localeCompare(arrivalB);

    const priA = Boolean(a.isPriority);
    const priB = Boolean(b.isPriority);
    if (priA !== priB) return priA ? -1 : 1;

    const sa = a.stock != null ? Number(a.stock) || 0 : 0;
    const sb = b.stock != null ? Number(b.stock) || 0 : 0;
    if (sa !== sb) return sb - sa;
    return 0;
  });
  return list;
}
