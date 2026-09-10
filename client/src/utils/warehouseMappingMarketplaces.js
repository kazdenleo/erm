import { parseYandexWarehouseMapping } from './yandexWarehouseMapping.js';

/** Коды маркетплейсов в warehouse_mappings (как в БД: ozon | wb | ym). */

export const WAREHOUSE_MAPPING_MARKETPLACES = [
  { value: 'ozon', label: 'Ozon' },
  { value: 'wb', label: 'Wildberries' },
  { value: 'ym', label: 'Яндекс Маркет' },
];

const LABELS = Object.fromEntries(
  WAREHOUSE_MAPPING_MARKETPLACES.map((o) => [o.value, o.label])
);

export function normalizeWarehouseMappingMarketplace(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'wildberries' || v === 'wb') return 'wb';
  if (v === 'yandex' || v === 'ym' || v === 'яндекс' || v === 'яндекс маркет') return 'ym';
  if (v === 'ozon') return 'ozon';
  return v;
}

export function warehouseMappingMarketplaceLabel(value) {
  const code = normalizeWarehouseMappingMarketplace(value);
  return LABELS[code] || String(value || '').toUpperCase() || '—';
}

/** Числовой ID склада МП: "991873" или "991873 — Мой склад". Название без ID → ''. */
export function extractMarketplaceWarehouseBindId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/^(\d{1,20})/);
  return m ? m[1] : '';
}

function looksLikeMarketplaceWarehouseId(s) {
  return /^\d{1,20}$/.test(String(s ?? '').trim());
}

function erpWarehouseTitle(wh, mapping) {
  const candidates = [
    wh?.name,
    mapping?.warehouse_name,
    mapping?.warehouseName,
    wh?.address,
    mapping?.warehouse_address,
    mapping?.warehouseAddress,
  ];
  for (const c of candidates) {
    const t = String(c ?? '').trim();
    if (t && !looksLikeMarketplaceWarehouseId(t)) return t;
  }
  return '';
}

function mappingMarketplaceIds(stored) {
  const yandex = parseYandexWarehouseMapping(stored);
  return [...new Set([
    extractMarketplaceWarehouseBindId(stored),
    yandex.warehouseId,
    yandex.campaignId,
  ].filter(Boolean))];
}

function orderMarketplaceIds(raw) {
  const yandex = parseYandexWarehouseMapping(raw);
  return [...new Set([
    extractMarketplaceWarehouseBindId(raw),
    yandex.warehouseId,
    yandex.campaignId,
  ].filter(Boolean))];
}

/** Короткое имя склада МП для списка заказов: «1818583 — Киров» → «Киров». Чистый ID → ''. */
export function marketplaceWarehouseDisplayName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const m = s.match(/^\d{1,20}\s*[—–-]\s*(.+)$/);
  if (m) {
    const name = m[1].trim();
    return looksLikeMarketplaceWarehouseId(name) ? '' : name;
  }
  if (looksLikeMarketplaceWarehouseId(s)) return '';
  return s;
}

/**
 * Наш склад ERP по ID склада МП из привязок. Не возвращает ID и не название склада МП.
 */
export function resolveOrderIncomingWarehouseTitle(raw, { warehouses = [], mappings = [], marketplace } = {}) {
  const mpIds = orderMarketplaceIds(raw);
  if (mpIds.length === 0) return '';
  const mp = normalizeWarehouseMappingMarketplace(marketplace);

  for (const mapping of mappings || []) {
    if (mp && normalizeWarehouseMappingMarketplace(mapping?.marketplace) !== mp) continue;
    const stored = mapping?.marketplace_warehouse_id ?? mapping?.marketplaceWarehouseId ?? '';
    const mappedIds = mappingMarketplaceIds(stored);
    if (!mappedIds.some((id) => mpIds.includes(id))) continue;
    const erpId = mapping?.warehouse_id ?? mapping?.warehouseId;
    const wh = (warehouses || []).find((w) => String(w.id) === String(erpId));
    const title = erpWarehouseTitle(wh, mapping);
    if (title) return title;
  }
  return '';
}

export function marketplaceWarehouseOptionSelected(stored, optionId) {
  const a = extractMarketplaceWarehouseBindId(stored);
  const b = extractMarketplaceWarehouseBindId(optionId);
  if (a && b) return a === b;
  return String(stored ?? '').trim() === String(optionId ?? '').trim();
}

/** Подпись сохранённой привязки: предупреждаем, если записано название без ID. */
export function formatMarketplaceWarehouseStoredLabel(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '—';
  const id = extractMarketplaceWarehouseBindId(s);
  if (!id) return `${s} (нет ID — выберите склад из списка)`;
  return s;
}

export function warehouseMappingMarketplaceHint(marketplace) {
  const mp = normalizeWarehouseMappingMarketplace(marketplace);
  if (mp === 'wb') {
    return (
      'Привязка идёт по числовому ID склада продавца WB (поле id из API /warehouses), не по названию. ' +
      'Выберите склад из списка — сохранится ID, например 991873.'
    );
  }
  if (mp === 'ym') {
    return (
      'У Яндекса три разных числа: campaignId (API, для заказов) ≠ «ID магазина» в кабинете ≠ «ID склада». ' +
      'В первом поле — campaignId из API, во втором — ID склада из кабинета (его же отдаёт API складов).'
    );
  }
  return (
    'Привязка идёт по числовому warehouse_id Ozon, не по названию. ' +
    'Выберите склад из списка — сохранится ID.'
  );
}
