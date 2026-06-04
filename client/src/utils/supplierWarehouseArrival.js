/** Когда приедет товар при заказе в окне времени (склад поставщика). */
export const SUPPLIER_ARRIVAL_TODAY = 'today';
export const SUPPLIER_ARRIVAL_TOMORROW = 'tomorrow';

const WAREHOUSE_TIME_RE = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;

export function normalizeWarehouseTime(value, fallback = '') {
  const t = String(value ?? '').trim();
  if (!t) return fallback;
  const short = t.length >= 5 ? t.slice(0, 5) : t;
  return WAREHOUSE_TIME_RE.test(short) ? short : fallback;
}

export const SUPPLIER_ARRIVAL_OPTIONS = [
  { value: SUPPLIER_ARRIVAL_TODAY, label: 'Сегодня' },
  { value: SUPPLIER_ARRIVAL_TOMORROW, label: 'Завтра' },
];

export function normalizeSupplierWarehouseArrivalDay(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === SUPPLIER_ARRIVAL_TOMORROW || v === 'завтра') return SUPPLIER_ARRIVAL_TOMORROW;
  return SUPPLIER_ARRIVAL_TODAY;
}

export function supplierWarehouseArrivalLabel(value) {
  return normalizeSupplierWarehouseArrivalDay(value) === SUPPLIER_ARRIVAL_TOMORROW
    ? 'Завтра'
    : 'Сегодня';
}

export function mapSupplierWarehouseFromApi(w) {
  if (!w || typeof w !== 'object') {
    return {
      name: '',
      timeAfter: '09:00',
      time: '18:00',
      arrivalDay: SUPPLIER_ARRIVAL_TODAY,
    };
  }
  const timeAfterRaw = w.timeAfter ?? w.time_after ?? '';
  return {
    name: w.name || '',
    time: normalizeWarehouseTime(w.time ?? w.timeUntil ?? w.time_until, '18:00'),
    timeAfter: normalizeWarehouseTime(timeAfterRaw, '09:00'),
    arrivalDay: normalizeSupplierWarehouseArrivalDay(
      w.arrivalDay ?? w.arrival_day ?? w.goodsArrival ?? w.goods_arrival
    ),
  };
}

export function warehouseRowToPayload(w) {
  const row = {
    name: String(w?.name ?? '').trim(),
    time: normalizeWarehouseTime(w?.time, '18:00'),
    arrivalDay: normalizeSupplierWarehouseArrivalDay(w?.arrivalDay),
  };
  const timeAfter = normalizeWarehouseTime(w?.timeAfter, '');
  if (timeAfter) row.timeAfter = timeAfter;
  return row;
}

/** Текст окна заказа для списка: «с 09:00 до 18:00, приедет завтра». */
export function formatSupplierWarehouseOrderWindow(w) {
  const until = w?.time || '—';
  const after = normalizeWarehouseTime(w?.timeAfter ?? w?.time_after, '');
  const window = after ? `с ${after} до ${until}` : `до ${until}`;
  const arrival = supplierWarehouseArrivalLabel(
    w?.arrivalDay ?? w?.arrival_day
  ).toLowerCase();
  return `${window}, приедет ${arrival}`;
}
