/**
 * Привязка типов этикеток к принтерам на этом рабочем месте (localStorage).
 * Пустое имя = принтер Windows по умолчанию.
 */

export const LABEL_PRINTER_STORAGE_KEY = 'erm_label_printers';

/**
 * @typedef {'order'|'product'|'packaging'|'shipment'|'box_ozon'|'box_wb'|'box_ym'|'pallet'|'cargo'|'box'} LabelPrintKind
 */

export const LABEL_PRINT_KINDS = [
  {
    id: 'order',
    label: 'Стикеры заказов',
    hint: 'FBS: этикетка отправления после сборки',
  },
  {
    id: 'shipment',
    label: 'Стикер отгрузки',
    hint: 'QR поставки WB при печати из раздела «Отгрузки». Пусто — принтер Windows по умолчанию',
  },
  {
    id: 'product',
    label: 'Стикеры товаров',
    hint: 'Этикетки товаров и сборка FBO по штукам',
  },
  {
    id: 'packaging',
    label: 'ШК упаковок товара',
    hint: 'Печать штрихкода упаковки из карточки товара (коробка с N шт.)',
  },
  {
    id: 'box_ozon',
    label: 'Короба FBO — Ozon',
    hint: 'Этикетки грузомест-коробов Ozon',
  },
  {
    id: 'box_wb',
    label: 'Короба FBO — Wildberries',
    hint: 'Этикетки коробов WB (FBW)',
  },
  {
    id: 'box_ym',
    label: 'Короба FBO — Яндекс Маркет',
    hint: 'Ярлыки грузомест / коробов Маркета',
  },
  {
    id: 'pallet',
    label: 'Стикеры паллет',
    hint: 'FBO: этикетки паллет (Ozon)',
  },
  {
    id: 'cargo',
    label: 'Стикеры грузомест (ТГМ)',
    hint: 'Транспортные грузоместа Ozon (ТГМ)',
  },
];

function emptyMap() {
  return {
    order: '',
    shipment: '',
    product: '',
    packaging: '',
    box_ozon: '',
    box_wb: '',
    box_ym: '',
    pallet: '',
    cargo: '',
    /** @deprecated legacy — читаем как fallback для box_* */
    box: '',
  };
}

/** Нормализация маркетплейса поставки → ключ принтера коробов. */
export function fboBoxPrintKind(marketplace) {
  const mp = String(marketplace || 'ozon').toLowerCase().trim();
  if (mp === 'wb' || mp === 'wildberries') return 'box_wb';
  if (mp === 'ym' || mp === 'yandex' || mp === 'yandex_market') return 'box_ym';
  return 'box_ozon';
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
    // Миграция: старый единый «box» → пустые box_* наследуют его при чтении (см. getLabelPrinter).
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
  if (map[key]) return String(map[key]).trim();
  // Совместимость со старой настройкой «Стикеры коробов»
  if (key === 'box_ozon' || key === 'box_wb' || key === 'box_ym' || key === 'box') {
    if (map.box) return String(map.box).trim();
  }
  // Ярлыки Маркета раньше шли на «грузоместа»
  if (key === 'box_ym' && map.cargo) return String(map.cargo).trim();
  return '';
}

/** @param {LabelPrintKind|string} kind @param {string} printerName */
export function setLabelPrinter(kind, printerName) {
  const map = getLabelPrinterMap();
  map[String(kind)] = String(printerName || '').trim();
  return setLabelPrinterMap(map);
}
