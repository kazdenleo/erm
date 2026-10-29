/**
 * Мин. сумма закупки vs срок отгрузки на маркетплейсе.
 * Копить заказы можно только пока есть запас дней до shipment_date.
 */

/** YYYY-MM-DD в Europe/Moscow. */
export function moscowYmdFromDate(dateLike) {
  if (dateLike == null || dateLike === '') return null;
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!y || !m || !day) return null;
  return `${y}-${m}-${day}`;
}

/** Разница в днях: toYmd − fromYmd (отрицательная, если to раньше). */
export function ymdDiffDays(fromYmd, toYmd) {
  const a = String(fromYmd || '').trim();
  const b = String(toYmd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const [ay, am, ad] = a.split('-').map((x) => parseInt(x, 10));
  const [by, bm, bd] = b.split('-').map((x) => parseInt(x, 10));
  const t0 = Date.UTC(ay, am - 1, ad);
  const t1 = Date.UTC(by, bm - 1, bd);
  return Math.round((t1 - t0) / 86400000);
}

/**
 * Можно ли ждать накопления до мин. суммы поставщика.
 * @param {object} opts
 * @param {Date|string|null} [opts.shipmentDeadline] — срок отгрузки заказа на МП
 * @param {string|null} [opts.plannedDeliveryYmd] — плановый приход от поставщика (YYYY-MM-DD)
 * @param {number} [opts.minSlackDays=1] — сколько полных дней запаса нужно, чтобы копить
 */
export function canWaitForMinOrderAmount({
  shipmentDeadline = null,
  plannedDeliveryYmd = null,
  minSlackDays = 1,
} = {}) {
  const shipYmd = moscowYmdFromDate(shipmentDeadline);
  const readyYmd = String(plannedDeliveryYmd || '').trim();
  if (!shipYmd || !/^\d{4}-\d{2}-\d{2}$/.test(readyYmd)) {
    // Нет срока на заказе — копим как раньше.
    return true;
  }
  const slack = ymdDiffDays(readyYmd, shipYmd);
  if (slack == null) return true;
  const need = Math.max(0, Math.floor(Number(minSlackDays) || 0));
  return slack >= need;
}

/** Срок горит или приход уже в день отгрузки / позже — мин. сумму не ждём. */
export function shouldBypassMinOrderAmount(opts = {}) {
  return !canWaitForMinOrderAmount(opts);
}
