/**
 * Операционные схемы продаж (зеркало server/src/constants/marketplaceSalesSchemes.js).
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

export const EXTRA_SALES_SCHEME_FLAGS = Object.freeze([
  {
    key: SALES_SCHEME.DBS,
    field: 'dbs_enabled',
    label: 'Работать по DBS / DBW',
    shortLabel: 'DBS',
    description:
      'Доставка продавцом до покупателя. Когда включено — заказы DBS не попадают в FBS-сборку.',
  },
  {
    key: SALES_SCHEME.EDBS,
    field: 'edbs_enabled',
    label: 'Работать по EDBS / Express',
    shortLabel: 'EDBS',
    description:
      'Экспресс-доставка продавцом. Отдельная комиссия и более жёсткие сроки.',
  },
  {
    key: SALES_SCHEME.CNC,
    field: 'cnc_enabled',
    label: 'Работать по C&C / самовывоз',
    shortLabel: 'C&C',
    description:
      'Покупатель забирает заказ у вас. Отдельный контур выдачи.',
  },
  {
    key: SALES_SCHEME.RFBS,
    field: 'rfbs_enabled',
    label: 'Работать по rFBS',
    shortLabel: 'rFBS',
    description:
      'Гибрид «склад продавца у МП». Учитывается в комиссиях и разметке заказов.',
  },
  {
    key: SALES_SCHEME.BOOKING,
    field: 'booking_enabled',
    label: 'Работать по бронированию',
    shortLabel: 'Бронь',
    description:
      'Схема бронирования WB (не классическая отгрузка FBS/FBO).',
  },
]);

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

export function salesSchemeLabel(scheme) {
  const s = String(scheme || '').toLowerCase();
  const map = {
    fbs: 'FBS',
    fbo: 'FBO',
    dbs: 'DBS',
    edbs: 'EDBS',
    cnc: 'C&C',
    rfbs: 'rFBS',
    booking: 'Бронь',
  };
  return map[s] || (s ? String(scheme).toUpperCase() : '—');
}
