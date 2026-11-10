/** Окно «сейчас собирают/упаковывают», мс. */
export const FBO_SUPPLY_ACTIVE_MS = 5 * 60 * 1000;

export const FBO_SUPPLY_STATUS_LABELS = {
  new: 'Новая',
  collecting: 'Сборка',
  packing: 'Упаковка',
  ready_for_supply: 'Готова к отгрузке',
  shipped: 'Отгружен',
  closed: 'Закрыт',
  return: 'Возврат',
};

/** Подписи фильтров (= этап; совпадают с обычными лейблами). */
export const FBO_SUPPLY_STATUS_FILTER_LABELS = {
  ...FBO_SUPPLY_STATUS_LABELS,
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

export const MARKETPLACE_LABELS = {
  ozon: 'Ozon',
  wb: 'Wildberries',
  ym: 'Яндекс Маркет',
};

export function normalizeFboSupplyStatus(status) {
  const s = String(status || '').trim();
  if (s === 'packed') return 'ready_for_supply';
  return s || 'new';
}

export function isFboSupplyActivityFresh(iso, now = Date.now()) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && now - t >= 0 && now - t <= FBO_SUPPLY_ACTIVE_MS;
}

/**
 * Подпись статуса.
 * «Собирается» / «Упаковывается» — только если активность ≤ 5 мин.
 * @param {string} status
 * @param {{ lastCollectAt?: string|null, lastPackAt?: string|null }|null} [activity]
 */
export function getFboSupplyStatusLabel(status, activity = null) {
  const s = normalizeFboSupplyStatus(status);
  if (activity) {
    if (
      s === 'collecting' &&
      isFboSupplyActivityFresh(activity.lastCollectAt ?? activity.last_collect_at)
    ) {
      return 'Собирается';
    }
    if (
      s === 'packing' &&
      isFboSupplyActivityFresh(activity.lastPackAt ?? activity.last_pack_at)
    ) {
      return 'Упаковывается';
    }
  }
  return FBO_SUPPLY_STATUS_LABELS[s] || s || '—';
}

export function getFboSupplyStatusFilterLabel(status) {
  const s = normalizeFboSupplyStatus(status);
  return FBO_SUPPLY_STATUS_FILTER_LABELS[s] || FBO_SUPPLY_STATUS_LABELS[s] || s || '—';
}

/** CSS-модификатор для бейджа / степпера по статусу. */
export function getFboSupplyStatusClass(status, activity = null) {
  const key = normalizeFboSupplyStatus(status).toLowerCase();
  if (activity) {
    if (
      key === 'collecting' &&
      isFboSupplyActivityFresh(activity.lastCollectAt ?? activity.last_collect_at)
    ) {
      return 'collecting';
    }
    if (
      key === 'packing' &&
      isFboSupplyActivityFresh(activity.lastPackAt ?? activity.last_pack_at)
    ) {
      return 'packing';
    }
  }
  if (FBO_SUPPLY_STATUS_ORDER.includes(key)) return key;
  return 'unknown';
}

export function getFboSupplyStatusRank(status) {
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(normalizeFboSupplyStatus(status));
  return idx >= 0 ? idx : -1;
}

export function getNextFboSupplyStatus(current) {
  const idx = FBO_SUPPLY_STATUS_ORDER.indexOf(normalizeFboSupplyStatus(current));
  if (idx < 0 || idx >= FBO_SUPPLY_STATUS_ORDER.length - 2) return null;
  return FBO_SUPPLY_STATUS_ORDER[idx + 1];
}

/** Статусы в селекте (без «Возврат» — редкий кейс). */
export const FBO_SUPPLY_STATUS_OPTIONS = FBO_SUPPLY_STATUS_ORDER.filter((s) => s !== 'return');

/** Можно выбрать статус (запрет «Готова к отгрузке» при расхождениях). */
export function canSelectFboSupplyStatus(status, hasDiscrepancy) {
  if (!hasDiscrepancy) return true;
  return normalizeFboSupplyStatus(status) !== 'ready_for_supply';
}

export function fboSupplyStatusBlockedTitle(status, hasDiscrepancy) {
  if (!hasDiscrepancy) return null;
  if (normalizeFboSupplyStatus(status) === 'ready_for_supply') {
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
