export const FBO_SUPPLY_STATUS_LABELS = {
  new: 'Новая',
  assembled: 'Собран',
  packed: 'Упакован',
  ready_for_supply: 'Готов к поставке',
  shipped: 'Отгружен',
  closed: 'Закрыт',
  return: 'Возврат',
};

export const FBO_SUPPLY_STATUS_ORDER = [
  'new',
  'assembled',
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

/** Есть расхождение план/факт по сборке. */
export function hasPackingDiscrepancy(supply, packing) {
  if (supply?.hasPackingDiscrepancy === true) return true;
  if (supply?.packingAllMatch === true) return false;
  const stats = packing?.itemStats;
  if (Array.isArray(stats) && stats.length) {
    return stats.some((s) => Number(s.packed) !== Number(s.planned));
  }
  const items = supply?.items;
  if (!Array.isArray(items) || !items.length) return true;
  return true;
}

export function getMarketplaceLabel(mp) {
  return MARKETPLACE_LABELS[mp] || mp || '—';
}
