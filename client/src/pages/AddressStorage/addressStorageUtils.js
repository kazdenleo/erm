/**
 * Адресное хранение: группировка ячеек по стеллажам, цвета тепловой карты, подписи.
 */

export const LOCATION_TYPE_LABELS = {
  storage: 'Хранение',
  picking: 'Отбор',
  receiving: 'Приёмка',
  shipping: 'Отгрузка',
  defect: 'Брак',
  returns: 'Возвраты',
};

export const MODE_LABELS = {
  fixed: 'Закреплённое — у каждого товара своя ячейка',
  dynamic: 'Динамическое — кладём в любую свободную ячейку',
  mixed: 'Смешанное — закреплённая ячейка отбора, излишки где угодно',
};

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

export function compareText(a, b) {
  return collator.compare(String(a ?? ''), String(b ?? ''));
}

export function compareParts(a = [], b = []) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const c = compareText(a[i], b[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Стеллаж = все уровни, кроме двух последних (полка и ячейка).
 * 2 уровня: стеллаж + полка; 1 уровень: всё в одном «стеллаже».
 */
export function splitAddress(parts = [], separator = '-') {
  const n = parts.length;
  if (n >= 3) {
    return { rackKey: parts.slice(0, n - 2).join(separator), shelf: parts[n - 2], cell: parts[n - 1] };
  }
  if (n === 2) return { rackKey: parts[0], shelf: parts[1], cell: '' };
  return { rackKey: '', shelf: '', cell: parts[0] ?? '' };
}

/** [{ key, shelves: [{ shelf, cells: [location] }], locations }] — полки сверху вниз (старшая сверху). */
export function groupRacks(locations = [], separator = '-') {
  const racks = new Map();
  for (const loc of locations) {
    const { rackKey, shelf } = splitAddress(loc.parts, separator);
    if (!racks.has(rackKey)) racks.set(rackKey, { key: rackKey, shelvesMap: new Map(), locations: [] });
    const rack = racks.get(rackKey);
    rack.locations.push(loc);
    if (!rack.shelvesMap.has(shelf)) rack.shelvesMap.set(shelf, []);
    rack.shelvesMap.get(shelf).push(loc);
  }
  return [...racks.values()]
    .sort((a, b) => compareText(a.key, b.key))
    .map((r) => ({
      key: r.key,
      locations: r.locations,
      shelves: [...r.shelvesMap.entries()]
        .sort((a, b) => compareText(b[0], a[0]))
        .map(([shelf, cells]) => ({
          shelf,
          cells: [...cells].sort((a, b) => compareParts(a.parts, b.parts)),
        })),
    }));
}

export const HEAT_METRICS = [
  { key: 'type', label: 'Тип ячейки' },
  { key: 'fill', label: 'Заполненность' },
  { key: 'shipped', label: 'Отгрузки' },
  { key: 'idle', label: 'Без движения' },
];

const TYPE_COLORS = {
  storage: '#ffffff',
  picking: '#d0ebff',
  receiving: '#fff3bf',
  shipping: '#d3f9d8',
  defect: '#ffe3e3',
  returns: '#f3d9fa',
};

function mix(a, b, t) {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  const k = Math.max(0, Math.min(1, t));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
}

/** Значение для метрики: { value 0..1, over } по ячейке (stat из тепловой карты). */
export function heatValue(metric, loc, stat, maxima) {
  if (metric === 'fill') {
    const qty = stat?.quantity ?? loc.stockQty ?? 0;
    const occupied = qty > 0 || (loc.products || []).length > 0;
    if (loc.capacity) return { value: qty / loc.capacity, over: qty > loc.capacity, occupied };
    if (maxima.quantity > 0 && qty > 0) return { value: qty / maxima.quantity, occupied };
    return { value: occupied ? 0.15 : 0, occupied };
  }
  if (metric === 'shipped') {
    const v = stat?.shipped ?? 0;
    return { value: maxima.shipped > 0 ? v / maxima.shipped : 0, occupied: (stat?.products ?? 0) > 0 };
  }
  if (metric === 'idle') {
    if (!stat?.products) return { value: 0, occupied: false };
    const d = stat.idleDays == null ? 180 : stat.idleDays;
    return { value: Math.min(1, d / 90), occupied: true };
  }
  return { value: 0, occupied: (loc.products || []).length > 0 };
}

/** Цвет по нормированному значению метрики { value, over, occupied }. */
export function colorForHeat(metric, h) {
  if (!h.occupied && h.value === 0) return '#f8f9fa';
  if (metric === 'fill') return h.over ? '#ff8787' : mix('ebfbee', '2f9e44', 0.15 + h.value * 0.85);
  if (metric === 'shipped') return mix('fff4e6', 'e03131', h.value);
  if (metric === 'idle') return mix('e7f5ff', '364fc7', h.value);
  return '#fff';
}

export function heatColor(metric, loc, stat, maxima) {
  if (!loc.isActive) return '#e9ecef';
  if (metric === 'type') return TYPE_COLORS[loc.type] || '#fff';
  return colorForHeat(metric, heatValue(metric, loc, stat, maxima));
}

/** Сводная метрика стеллажа для плана склада. */
export function rackHeat(metric, rackLocations, statsById, rackMaxShipped) {
  const total = rackLocations.length || 1;
  if (metric === 'fill') {
    let qty = 0;
    let cap = 0;
    let occupied = 0;
    let over = false;
    for (const l of rackLocations) {
      const q = statsById.get(l.id)?.quantity ?? 0;
      if (q > 0 || l.products.length) occupied += 1;
      if (l.capacity) {
        qty += q;
        cap += l.capacity;
        if (q > l.capacity) over = true;
      }
    }
    const value = cap > 0 ? qty / cap : occupied / total;
    return { value: Math.min(1, value), over, occupied: occupied > 0 };
  }
  if (metric === 'shipped') {
    const sum = rackLocations.reduce((s, l) => s + (statsById.get(l.id)?.shipped ?? 0), 0);
    return { value: rackMaxShipped > 0 ? sum / rackMaxShipped : 0, occupied: sum > 0, sum };
  }
  if (metric === 'idle') {
    const vals = rackLocations
      .map((l) => statsById.get(l.id))
      .filter((s) => s?.products)
      .map((s) => Math.min(1, (s.idleDays == null ? 180 : s.idleDays) / 90));
    if (!vals.length) return { value: 0, occupied: false };
    return { value: vals.reduce((a, b) => a + b, 0) / vals.length, occupied: true };
  }
  return { value: 0, occupied: false };
}

export function heatMaxima(cells = []) {
  return cells.reduce(
    (m, c) => ({ quantity: Math.max(m.quantity, c.quantity || 0), shipped: Math.max(m.shipped, c.shipped || 0) }),
    { quantity: 0, shipped: 0 }
  );
}

export function locationTooltip(loc, stat) {
  const lines = [loc.code, LOCATION_TYPE_LABELS[loc.type] || loc.type];
  if (loc.capacity != null) lines.push(`Вместимость: ${loc.capacity}`);
  if (stat) {
    lines.push(`В ячейке: ${stat.quantity} шт`);
    if (stat.shipped) lines.push(`Отгружено: ${stat.shipped} шт`);
    if (stat.idleDays != null) lines.push(`Без движения: ${stat.idleDays} дн.`);
  }
  for (const p of loc.products || []) {
    lines.push(`${p.assigned ? '📌 ' : ''}${p.sku || ''} ${p.name || ''}${p.quantity ? ` — ${p.quantity} шт` : ''}`.trim());
  }
  if (!loc.isActive) lines.push('Отключена');
  return lines.join('\n');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if (!w) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
