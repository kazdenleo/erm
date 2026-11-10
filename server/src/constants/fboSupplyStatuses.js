/** Статусы поставки FBO */
export const FBO_SUPPLY_STATUSES = [
  'new',
  'collecting',
  'packing',
  'ready_for_supply',
  'shipped',
  'closed',
  'return',
];

export const FBO_SUPPLY_STATUS_LABELS = {
  new: 'Новая',
  collecting: 'Сборка',
  packing: 'Упаковка',
  ready_for_supply: 'Готова к отгрузке',
  shipped: 'Отгружен',
  closed: 'Закрыт',
  return: 'Возврат',
};

export const FBO_SUPPLY_STATUS_ORDER = [
  'new',
  'collecting',
  'packing',
  'ready_for_supply',
  'shipped',
  'closed',
  'return',
];

/** Нормализация устаревшего packed → ready_for_supply. */
export function normalizeFboSupplyStatus(status) {
  const s = String(status || '').trim();
  if (s === 'packed') return 'ready_for_supply';
  return s || 'new';
}

export function getNextFboSupplyStatus(current) {
  const cur = normalizeFboSupplyStatus(current);
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(cur);
  if (idx < 0 || idx >= FBO_SUPPLY_STATUS_ORDER.length - 2) return null;
  return FBO_SUPPLY_STATUS_ORDER[idx + 1];
}

export function getFboSupplyStatusRank(status) {
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(normalizeFboSupplyStatus(status));
  return idx >= 0 ? idx : -1;
}

/** Финальные статусы — фоновая синхронизация с МП больше не нужна. */
export const FBO_SUPPLY_TERMINAL_STATUSES = ['closed', 'return'];

export function isFboSupplyTerminalStatus(status) {
  return FBO_SUPPLY_TERMINAL_STATUSES.includes(normalizeFboSupplyStatus(status));
}

/** Статус после синхронизации с МП: только вперёд по цепочке или «Возврат». */
export function pickStatusAfterMarketplaceSync(current, marketplaceStatus) {
  const cur = normalizeFboSupplyStatus(current);
  const mp = normalizeFboSupplyStatus(marketplaceStatus);
  if (!marketplaceStatus || !FBO_SUPPLY_STATUSES.includes(mp)) return cur;
  if (mp === 'return') return 'return';
  if (cur === 'return') return cur;
  const curR = getFboSupplyStatusRank(cur);
  const mpR = getFboSupplyStatusRank(mp);
  if (curR < 0 || mpR < 0) return cur;
  return mpR > curR ? mp : cur;
}
