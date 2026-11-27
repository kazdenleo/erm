/**
 * Операционные схемы продаж маркетплейсов.
 * FBS/FBO уже в профиле; остальные — доп. флаги (по умолчанию выкл).
 */

export const SALES_SCHEME = Object.freeze({
  FBS: 'fbs',
  FBO: 'fbo',
  DBS: 'dbs',
  EDBS: 'edbs',
  CNC: 'cnc',
  RFBS: 'rfbs',
  BOOKING: 'booking',
});

/** Доп. схемы (помимо FBS/FBO) — колонки profiles.*_enabled */
export const EXTRA_SALES_SCHEME_FLAGS = Object.freeze([
  {
    key: SALES_SCHEME.DBS,
    column: 'dbs_enabled',
    camel: 'dbsEnabled',
    label: 'DBS / DBW',
    shortLabel: 'DBS',
    description:
      'Доставка продавцом до покупателя (витрина/курьер). Заказы не смешиваются с FBS-сборкой, когда схема включена.',
  },
  {
    key: SALES_SCHEME.EDBS,
    column: 'edbs_enabled',
    camel: 'edbsEnabled',
    label: 'EDBS / Express',
    shortLabel: 'EDBS',
    description:
      'Экспресс-доставка продавцом. Поверх DBS: жёстче SLA, отдельная комиссия.',
  },
  {
    key: SALES_SCHEME.CNC,
    column: 'cnc_enabled',
    camel: 'cncEnabled',
    label: 'C&C / самовывоз',
    shortLabel: 'C&C',
    description:
      'Покупатель забирает заказ у продавца. Отдельный контур выдачи, без сдачи в логистику МП.',
  },
  {
    key: SALES_SCHEME.RFBS,
    column: 'rfbs_enabled',
    camel: 'rfbsEnabled',
    label: 'rFBS',
    shortLabel: 'rFBS',
    description:
      'Гибрид «склад продавца у МП» (realFBS). Ближе к FBS по отгрузке, но с инфраструктурой МП.',
  },
  {
    key: SALES_SCHEME.BOOKING,
    column: 'booking_enabled',
    camel: 'bookingEnabled',
    label: 'Бронирование',
    shortLabel: 'Бронь',
    description:
      'Схема бронирования WB (не классическая отгрузка FBS/FBO).',
  },
]);

/** Ключи комиссий по схемам для каждого МП (подсветка «рабочих» в категориях / мин. цены). */
export const MP_COMMISSION_SCHEME_KEYS = Object.freeze({
  wb: {
    fbs: 'kgvpMarketplace',
    fbo: 'paidStorageKgvp',
    dbs: 'kgvpSupplier',
    edbs: 'kgvpSupplierExpress',
    cnc: 'kgvpPickup',
    booking: 'kgvpBooking',
  },
  ozon: {
    fbs: 'FBS',
    fbo: 'FBO',
    dbs: 'DBS',
    rfbs: 'rFBS',
  },
  ym: {
    fbs: 'FBS',
    fbo: 'FBY',
    dbs: 'DBS',
    edbs: 'EXPRESS',
  },
});

export function normalizeSalesScheme(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (!s) return null;
  if (s === 'fbs' || s === 'marketplace') return SALES_SCHEME.FBS;
  if (s === 'fbo' || s === 'fby' || s === 'fbw' || s === 'paidstorage') return SALES_SCHEME.FBO;
  if (s === 'dbs' || s === 'dbw' || s === 'deliverybyseller') return SALES_SCHEME.DBS;
  if (s === 'edbs' || s === 'express' || s === 'expressdbs' || s === 'supplierexpress') {
    return SALES_SCHEME.EDBS;
  }
  if (
    s === 'cnc' ||
    s === 'clickcollect' ||
    s === 'clickandcollect' ||
    s === 'pickup' ||
    s === 'selfpickup' ||
    s === 'самовывоз'
  ) {
    return SALES_SCHEME.CNC;
  }
  if (s === 'rfbs' || s === 'realfbs') return SALES_SCHEME.RFBS;
  if (s === 'booking' || s === 'бронь' || s === 'бронирование') return SALES_SCHEME.BOOKING;
  if (s.includes('express')) return SALES_SCHEME.EDBS;
  if (s.includes('dbs') || s.includes('dbw')) return SALES_SCHEME.DBS;
  if (s.includes('fby') || s.includes('fbo') || s.includes('fbw')) return SALES_SCHEME.FBO;
  if (s.includes('rfbs') || s.includes('realfbs')) return SALES_SCHEME.RFBS;
  if (s.includes('pickup') || s.includes('cnc')) return SALES_SCHEME.CNC;
  if (s.includes('fbs')) return SALES_SCHEME.FBS;
  return null;
}

/**
 * Определить схему из сырого заказа МП (best-effort).
 * Неизвестный → null (считаем как FBS-пайплайн, чтобы ничего не ломать).
 */
export function detectSalesSchemeFromOrderPayload(marketplace, raw = {}) {
  const mp = String(marketplace || '')
    .trim()
    .toLowerCase();
  const src = raw && typeof raw === 'object' ? raw : {};

  const candidates = [
    src.salesScheme,
    src.sales_scheme,
    src.scheme,
    src.deliverySchema,
    src.delivery_schema,
    src.deliveryType,
    src.delivery_type,
    src.tpl,
    src.tplIntegrationType,
    src.tpl_integration_type,
    src.placementType,
    src.placement_type,
    src.campaignType,
    src.campaign_type,
    src.type,
  ];

  for (const c of candidates) {
    const n = normalizeSalesScheme(c);
    if (n) return n;
  }

  // WB: deliveryType часто fbs / dbs / edbs / self_pickup
  if (mp === 'wb' || mp === 'wildberries') {
    const dt = normalizeSalesScheme(src.deliveryType ?? src.delivery_type);
    if (dt) return dt;
  }

  // Ozon: tpl_integration_type / delivery_method
  if (mp === 'ozon') {
    const tpl = normalizeSalesScheme(
      src.tpl_integration_type ?? src.tplIntegrationType ?? src.delivery_method?.tpl_provider_type
    );
    if (tpl) return tpl;
  }

  // YM: тип кампании / delivery
  if (mp === 'ym' || mp === 'yandex' || mp === 'yandexmarket') {
    const t = normalizeSalesScheme(src.placementType ?? src.type ?? src.campaignType);
    if (t) return t;
  }

  return null;
}

/**
 * Схемы, по которым работает профиль (для комиссий / UI).
 * @param {{ fbs?: boolean, fbo?: boolean, dbs?: boolean, edbs?: boolean, cnc?: boolean, rfbs?: boolean, booking?: boolean }} flags
 */
export function getWorkingSchemeKeys(flags = {}) {
  const out = [];
  if (flags.fbs !== false) out.push(SALES_SCHEME.FBS);
  if (flags.fbo === true) out.push(SALES_SCHEME.FBO);
  if (flags.dbs === true) out.push(SALES_SCHEME.DBS);
  if (flags.edbs === true) out.push(SALES_SCHEME.EDBS);
  if (flags.cnc === true) out.push(SALES_SCHEME.CNC);
  if (flags.rfbs === true) out.push(SALES_SCHEME.RFBS);
  if (flags.booking === true) out.push(SALES_SCHEME.BOOKING);
  return out;
}

export function getMpCommissionKeysForWorkingSchemes(marketplace, flags = {}) {
  const mp = String(marketplace || '').toLowerCase();
  const mapKey = mp === 'wildberries' ? 'wb' : mp === 'yandex' || mp === 'yandexmarket' ? 'ym' : mp;
  const map = MP_COMMISSION_SCHEME_KEYS[mapKey];
  if (!map) return [];
  return getWorkingSchemeKeys(flags)
    .map((k) => map[k])
    .filter(Boolean);
}

export function describeWorkingSchemes(flags = {}) {
  const labels = {
    [SALES_SCHEME.FBS]: 'FBS',
    [SALES_SCHEME.FBO]: 'FBO',
    [SALES_SCHEME.DBS]: 'DBS',
    [SALES_SCHEME.EDBS]: 'EDBS',
    [SALES_SCHEME.CNC]: 'C&C',
    [SALES_SCHEME.RFBS]: 'rFBS',
    [SALES_SCHEME.BOOKING]: 'бронь',
  };
  const keys = getWorkingSchemeKeys(flags);
  if (!keys.length) return 'В Настройках аккаунта не включены схемы работы.';
  const names = keys.map((k) => labels[k] || k).join(', ');
  return `Работаете по ${names} — эти комиссии идут в расчёт мин. цен (Настройки аккаунта).`;
}

/**
 * Схемы, которые нужно вынести из FBS-сборки, если они включены в профиле.
 * Пока флаг выкл — заказы остаются в текущем FBS-контуре (совместимость).
 */
export function schemesExcludedFromFbsPipeline(flags = {}) {
  const out = [];
  if (flags.dbs === true) out.push(SALES_SCHEME.DBS);
  if (flags.edbs === true) out.push(SALES_SCHEME.EDBS);
  if (flags.cnc === true) out.push(SALES_SCHEME.CNC);
  if (flags.booking === true) out.push(SALES_SCHEME.BOOKING);
  // rFBS часто идёт через FBS-подобные API Ozon — не выкидываем из сборки по умолчанию
  return out;
}

export function parseBoolFlag(v) {
  return v === true || v === '1' || v === 'true';
}
