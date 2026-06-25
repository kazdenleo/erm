/** Статусы поставки FBO */
export const FBO_SUPPLY_STATUSES = [
  'new',
  'packed',
  'ready_for_supply',
  'shipped',
  'closed',
  'return',
];

export const FBO_SUPPLY_STATUS_LABELS = {
  new: 'Новая',
  packed: 'Упакован',
  ready_for_supply: 'Готов к отгрузке',
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

export function getNextFboSupplyStatus(current) {
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(current);
  if (idx < 0 || idx >= FBO_SUPPLY_STATUS_ORDER.length - 2) return null;
  return FBO_SUPPLY_STATUS_ORDER[idx + 1];
}

export function getFboSupplyStatusRank(status) {
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(status);
  return idx >= 0 ? idx : -1;
}

/** Финальные статусы — фоновая синхронизация с МП больше не нужна. */
export const FBO_SUPPLY_TERMINAL_STATUSES = ['closed', 'return'];

export function isFboSupplyTerminalStatus(status) {
  return FBO_SUPPLY_TERMINAL_STATUSES.includes(String(status || '').trim());
}

/** Статус после синхронизации с МП: только вперёд по цепочке или «Возврат». */
export function pickStatusAfterMarketplaceSync(current, marketplaceStatus) {
  if (!marketplaceStatus || !FBO_SUPPLY_STATUSES.includes(marketplaceStatus)) return current;
  if (marketplaceStatus === 'return') return 'return';
  if (current === 'return') return current;
  const curR = getFboSupplyStatusRank(current);
  const mpR = getFboSupplyStatusRank(marketplaceStatus);
  if (curR < 0 || mpR < 0) return current;
  return mpR > curR ? marketplaceStatus : current;
}
