export const FBO_SUPPLY_STATUS_LABELS = {
  new: 'Новый',
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

export function getMarketplaceLabel(mp) {
  return MARKETPLACE_LABELS[mp] || mp || '—';
}
