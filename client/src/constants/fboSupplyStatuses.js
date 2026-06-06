export const FBO_SUPPLY_STATUS_LABELS = {
  new: 'Новая',
  packed: 'Упакован',
  ready_for_supply: 'Готов к поставке',
  shipped: 'Отгружен',
  closed: 'Закрыт',
  return: 'Возврат',
};

export const FBO_SUPPLY_STATUS_ORDER = [
  'new',
  'packed',
  'ready_for_supply',
  'shipped',
  'closed',
  'return',
];

export const MARKETPLACE_LABELS = {
  ozon: 'Ozon',
  wb: 'Wildberries',
  ym: 'Яндекс Маркет',
};

export function getFboSupplyStatusLabel(status) {
  return FBO_SUPPLY_STATUS_LABELS[status] || status || '—';
}

export function getNextFboSupplyStatus(current) {
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(current);
  if (idx < 0 || idx >= FBO_SUPPLY_STATUS_ORDER.length - 2) return null;
  return FBO_SUPPLY_STATUS_ORDER[idx + 1];
}

/** Статусы в селекте (без «Возврат» — редкий кейс). */
export const FBO_SUPPLY_STATUS_OPTIONS = FBO_SUPPLY_STATUS_ORDER.filter((s) => s !== 'return');

/** Можно выбрать статус (единственный запрет — «Готов к поставке» при расхождениях). */
export function canSelectFboSupplyStatus(status, hasDiscrepancy) {
  if (status !== 'ready_for_supply') return true;
  return !hasDiscrepancy;
}

/** Есть расхождение план/факт по сборке. */
export function hasPackingDiscrepancy(supply, packing) {
  if (supply?.hasPackingDiscrepancy === true) return true;
  if (supply?.packingAllMatch === true) return false;
  if (supply?.packingAllMatch === false) return true;
  const stats = packing?.itemStats;
  if (Array.isArray(stats) && stats.length) {
    return stats.some((s) => Number(s.packed) !== Number(s.planned));
  }
  return false;
}

export function getMarketplaceLabel(mp) {
  return MARKETPLACE_LABELS[mp] || mp || '—';
}

/** Статусы заявки Ozon (API) → подпись как в ЛК. */
export const OZON_SUPPLY_STATE_LABELS = {
  DATA_FILLING: 'Заполнение данных',
  READY_TO_SUPPLY: 'Готово к отгрузке',
};

export function getOzonSupplyStateLabel(ozonState) {
  const key = String(ozonState || '').toUpperCase();
  return OZON_SUPPLY_STATE_LABELS[key] || key || '—';
}
