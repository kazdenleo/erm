export const SUPPLIER_ARRIVAL_TODAY = 'today';
export const SUPPLIER_ARRIVAL_TOMORROW = 'tomorrow';

const WAREHOUSE_TIME_RE = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;

export function normalizeWarehouseTime(value, fallback = '') {
  const t = String(value ?? '').trim();
  if (!t) return fallback;
  const short = t.length >= 5 ? t.slice(0, 5) : t;
  return WAREHOUSE_TIME_RE.test(short) ? short : fallback;
}

export function normalizeSupplierWarehouseArrivalDay(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === SUPPLIER_ARRIVAL_TOMORROW || v === 'завтра') return SUPPLIER_ARRIVAL_TOMORROW;
  return SUPPLIER_ARRIVAL_TODAY;
}

/** Нормализует склады в api_config перед записью в БД. */
export function normalizeSupplierConfigWarehouses(warehouses) {
  if (!Array.isArray(warehouses)) return warehouses;
  return warehouses.map((w) => {
    const row = w && typeof w === 'object' ? w : {};
    const normalized = {
      name: String(row.name ?? '').trim(),
      time: normalizeWarehouseTime(row.time ?? row.timeUntil ?? row.time_until, '18:00'),
      arrivalDay: normalizeSupplierWarehouseArrivalDay(
        row.arrivalDay ?? row.arrival_day ?? row.goodsArrival ?? row.goods_arrival
      ),
    };
    const timeAfter = normalizeWarehouseTime(row.timeAfter ?? row.time_after, '');
    if (timeAfter) normalized.timeAfter = timeAfter;
    return normalized;
  });
}

export function normalizeSupplierApiConfig(apiConfig) {
  if (!apiConfig || typeof apiConfig !== 'object') return apiConfig ?? {};
  const next = { ...apiConfig };
  if (Array.isArray(next.warehouses)) {
    next.warehouses = normalizeSupplierConfigWarehouses(next.warehouses);
  }
  return next;
}
