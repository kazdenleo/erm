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

export const MARKETPLACE_LABELS = {
  ozon: 'Ozon',
  wb: 'Wildberries',
  ym: 'Яндекс Маркет',
};

export function getFboSupplyStatusLabel(status) {
  return FBO_SUPPLY_STATUS_LABELS[status] || status || '—';
}

/** CSS-модификатор для бейджа / степпера по статусу. */
export function getFboSupplyStatusClass(status) {
  const key = String(status || '').toLowerCase();
  if (FBO_SUPPLY_STATUS_ORDER.includes(key)) return key;
  return 'unknown';
}

export function getFboSupplyStatusRank(status) {
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(status);
  return idx >= 0 ? idx : -1;
}

export function getNextFboSupplyStatus(current) {
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(current);
  if (idx < 0 || idx >= FBO_SUPPLY_STATUS_ORDER.length - 2) return null;
  return FBO_SUPPLY_STATUS_ORDER[idx + 1];
}

/** Статусы в селекте (без «Возврат» — редкий кейс). */
export const FBO_SUPPLY_STATUS_OPTIONS = FBO_SUPPLY_STATUS_ORDER.filter((s) => s !== 'return');

/** Можно выбрать статус (запрет «Упакован» и «Готов к отгрузке» при расхождениях). */
export function canSelectFboSupplyStatus(status, hasDiscrepancy) {
  if (!hasDiscrepancy) return true;
  return status !== 'packed' && status !== 'ready_for_supply';
}

export function fboSupplyStatusBlockedTitle(status, hasDiscrepancy) {
  if (!hasDiscrepancy) return null;
  if (status === 'packed' || status === 'ready_for_supply') {
    return 'Упакуйте по каждой позиции ровно запланированное количество';
  }
  return null;
}

/** Есть расхождение план/факт по сборке. */
export function hasPackingDiscrepancy(supply, packing) {
  if (supply?.hasPackingDiscrepancy === true) return true;
  if (supply?.packingAllMatch === true) return false;
  if (supply?.packingAllMatch === false) return true;
  const stats = packing?.itemStats;
  if (Array.isArray(stats) && stats.length) {
    return stats.some((s) => {
      const planned = Number(s.planned) || 0;
      const packed = Number(s.packed) || 0;
      if (planned <= 0) return packed > 0;
      return packed !== planned;
    });
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
