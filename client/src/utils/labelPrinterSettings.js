/**
 * Привязка типов этикеток к принтерам на этом рабочем месте (localStorage).
 * Пустое имя = принтер Windows по умолчанию.
 */

export const LABEL_PRINTER_STORAGE_KEY = 'erm_label_printers';

/** @typedef {'order'|'product'|'box'|'pallet'|'cargo'} LabelPrintKind */

export const LABEL_PRINT_KINDS = [
  {
    id: 'order',
    label: 'Стикеры заказов',
    hint: 'FBS: этикетка отправления после сборки',
  },
  {
    id: 'product',
    label: 'Стикеры товаров',
    hint: 'Этикетки товаров и сборка FBO по штукам',
  },
  {
    id: 'box',
    label: 'Стикеры коробов',
    hint: 'FBO: этикетки коробов (грузомест-коробов)',
  },
  {
    id: 'pallet',
    label: 'Стикеры паллет',
    hint: 'FBO: этикетки паллет',
  },
  {
    id: 'cargo',
    label: 'Стикеры грузомест',
    hint: 'Транспортные грузоместа (ТГМ) и ярлыки Маркета',
  },
];

function emptyMap() {
  return { order: '', product: '', box: '', pallet: '', cargo: '' };
}

export function getLabelPrinterMap() {
  try {
    const raw = localStorage.getItem(LABEL_PRINTER_STORAGE_KEY);
    if (!raw) return emptyMap();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyMap();
    const base = emptyMap();
    for (const k of Object.keys(base)) {
      if (parsed[k] != null) base[k] = String(parsed[k]).trim();
    }
    return base;
  } catch {
    return emptyMap();
  }
}

export function setLabelPrinterMap(map) {
  const next = { ...emptyMap(), ...(map || {}) };
  for (const k of Object.keys(next)) next[k] = String(next[k] ?? '').trim();
  localStorage.setItem(LABEL_PRINTER_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** @param {LabelPrintKind|string} kind */
export function getLabelPrinter(kind) {
  const map = getLabelPrinterMap();
  const key = String(kind || '').trim();
  return map[key] ? String(map[key]).trim() : '';
}

/** @param {LabelPrintKind|string} kind @param {string} printerName */
export function setLabelPrinter(kind, printerName) {
  const map = getLabelPrinterMap();
  map[String(kind)] = String(printerName || '').trim();
  return setLabelPrinterMap(map);
}
