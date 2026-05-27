/** Статусы поставки FBO */
export const FBO_SUPPLY_STATUSES = [
  'new',
  'assembled',
  'packed',
  'ready_for_supply',
  'shipped',
  'closed',
  'return',
];

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

export function getNextFboSupplyStatus(current) {
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(current);
  if (idx < 0 || idx >= FBO_SUPPLY_STATUS_ORDER.length - 2) return null;
  return FBO_SUPPLY_STATUS_ORDER[idx + 1];
}
