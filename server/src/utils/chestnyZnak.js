/**
 * Честный знак (ГИС МТ / True API): справочники, нормализация КИ, публичный конфиг.
 */

export const CHESTNY_ZNAK_CODE = 'chestny_znak';
export const CHESTNY_ZNAK_TYPE = 'other';

export const TRUE_API_PROD_V3 = 'https://markirovka.crpt.ru/api/v3/true-api';
export const TRUE_API_PROD_V4 = 'https://markirovka.crpt.ru/api/v4/true-api';
export const TRUE_API_SANDBOX_V3 = 'https://markirovka.sandbox.crpt.ru/api/v3/true-api';
export const TRUE_API_SANDBOX_V4 = 'https://markirovka.sandbox.crpt.ru/api/v4/true-api';

/** Коды товарных групп True API (pg). Справочник ГИС МТ, актуальные группы включая 2025–2026. */
export const CHESTNY_ZNAK_PRODUCT_GROUPS = [
  { id: 'tires', name: 'Шины и покрышки' },
  { id: 'autofluids', name: 'Моторные масла' },
  { id: 'chemistry', name: 'Косметика и бытовая химия' },
  { id: 'radio', name: 'Радиоэлектронная продукция' },
  { id: 'fire', name: 'Средства пожарной безопасности' },
  { id: 'heater', name: 'Отопительные приборы' },
  { id: 'electronics', name: 'Фотокамеры и вспышки' },
  { id: 'construction', name: 'Строительные материалы' },
  { id: 'antiseptic', name: 'Антисептики' },
  { id: 'bio', name: 'БАД' },
  { id: 'grocery', name: 'Бакалея' },
  { id: 'nabeer', name: 'Безалкогольное пиво' },
  { id: 'softdrinks', name: 'Безалкогольные напитки' },
  { id: 'otp', name: 'Альтернативный табак' },
  { id: 'bicycle', name: 'Велосипеды' },
  { id: 'water', name: 'Упакованная вода' },
  { id: 'petfood', name: 'Корма для животных' },
  { id: 'wheelchairs', name: 'Кресла-коляски' },
  { id: 'lp', name: 'Одежда (лёгпром)' },
  { id: 'conserve', name: 'Консервы' },
  { id: 'perfumery', name: 'Духи и туалетная вода' },
  { id: 'toys', name: 'Игры и игрушки' },
  { id: 'cabling', name: 'Кабельная продукция' },
  { id: 'pharma', name: 'Лекарственные препараты' },
  { id: 'medical', name: 'Медицинские изделия' },
  { id: 'furs', name: 'Меховые изделия' },
  { id: 'milk', name: 'Молочная продукция' },
  { id: 'seafood', name: 'Морепродукты' },
  { id: 'meat', name: 'Мясные изделия' },
  { id: 'ncp', name: 'Никотинсодержащая продукция' },
  { id: 'shoes', name: 'Обувь' },
  { id: 'opticfiber', name: 'Оптоволокно' },
  { id: 'beer', name: 'Пиво и слабоалкогольные напитки' },
  { id: 'vegetableoil', name: 'Растительные масла' },
  { id: 'sweets', name: 'Сладости и кондитерские изделия' },
  { id: 'tobacco', name: 'Табачная продукция' },
  { id: 'titan', name: 'Титановая металлопродукция' },
  { id: 'vetpharma', name: 'Ветеринарные препараты' },
  { id: 'books', name: 'Печатная продукция' },
];

export const CHESTNY_ZNAK_OPERATIONS = [
  {
    id: 'purchase_accept',
    name: 'Закупка / приёмка',
    hint: 'Входящий УПД с КИ от поставщика. Для шин обязателен ЭДО.',
    gis_type: 'LP_ACCEPT_GOODS',
    gis_action: null,
    channel: 'edo',
  },
  {
    id: 'wholesale_ship',
    name: 'Оптовая отгрузка',
    hint: 'Исходящий УПД покупателю — участнику оборота.',
    gis_type: 'LP_SHIP_GOODS',
    gis_action: null,
    channel: 'edo',
  },
  {
    id: 'fbo_transfer',
    name: 'Поставка FBO',
    hint: 'Передача КИ на склад маркетплейса УПД. Вывод при продаже делает площадка.',
    gis_type: 'LP_SHIP_GOODS',
    gis_action: null,
    channel: 'edo',
  },
  {
    id: 'fbs_distance',
    name: 'Продажа FBS / DBS',
    hint: 'Вывод из оборота «дистанционная продажа» после отгрузки со своего склада.',
    gis_type: 'LK_RECEIPT',
    gis_action: 'DISTANCE',
    channel: 'true_api',
  },
  {
    id: 'own_use',
    name: 'Покупка / списание себе',
    hint: 'Вывод «использование для собственных нужд» — со склада или сразу из закупки.',
    gis_type: 'LK_RECEIPT',
    gis_action: 'OWN_USE',
    channel: 'true_api',
  },
  {
    id: 'retail',
    name: 'Розница',
    hint: 'Вывод «розничная реализация», если продаёте не через маркетплейс.',
    gis_type: 'LK_RECEIPT',
    gis_action: 'RETAIL',
    channel: 'true_api',
  },
];

export function operationById(id) {
  return CHESTNY_ZNAK_OPERATIONS.find((o) => o.id === id) || null;
}

export function normalizeOperations(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const op of CHESTNY_ZNAK_OPERATIONS) {
    const v = src[op.id];
    if (v === false || v === 'false') out[op.id] = false;
    else if (v && typeof v === 'object' && v.enabled === false) out[op.id] = false;
    else out[op.id] = true;
  }
  return out;
}

export function buildLkReceiptPayload({ inn, action, actionDate, documentNumber, documentDate, products }) {
  return {
    inn: String(inn || ''),
    action: String(action || 'OWN_USE'),
    action_date: String(actionDate || '').slice(0, 10),
    document_type: 'OTHER',
    document_number: String(documentNumber || ''),
    document_date: String(documentDate || actionDate || '').slice(0, 10),
    products: (products || []).map((p) => (
      typeof p === 'string' ? { cis: p } : { cis: p.cis, ...(p.product_cost != null ? { product_cost: p.product_cost } : {}) }
    )),
  };
}

export function encodeProductDocument(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export const CIS_STATUS_LABELS = {
  EMITTED: 'Эмитирован',
  APPLIED: 'Нанесён',
  INTRODUCED: 'В обороте',
  RETIRED: 'Выбыл',
  WITHDRAWN: 'Выведен из оборота',
  WRITTEN_OFF: 'Списан',
  DISAGGREGATION: 'Расформирован',
  DISAGGREGATED: 'Расформирован',
  WAIT_SHIPMENT: 'Ожидает отгрузки',
  SHIPPED: 'Отгружен',
  EXPIRED: 'Истёк',
};

const GS_RE = /[\x1c\x1d\x1e\x1f\u241d\u00e8]/g;

export function normalizeCis(raw) {
  return String(raw ?? '')
    .replace(GS_RE, '')
    .replace(/^\u241d/, '')
    .trim();
}

export function splitCisList(text, { max = 900 } = {}) {
  const seen = new Set();
  const out = [];
  for (const part of String(text ?? '').split(/[\r\n,;]+/)) {
    const cis = normalizeCis(part);
    if (!cis || seen.has(cis)) continue;
    seen.add(cis);
    out.push(cis);
    if (out.length >= max) break;
  }
  return out;
}

/** GTIN-14 из КИ, если код начинается с AI 01. */
export function extractGtinFromCis(cis) {
  const s = normalizeCis(cis);
  if (s.startsWith('01') && s.length >= 16 && /^\d{14}/.test(s.slice(2, 16))) {
    return s.slice(2, 16);
  }
  return null;
}

/**
 * Data Matrix КИ, а не обычный EAN/GTIN/артикул.
 * EAN-8…GTIN-14 (только цифры) не считаем КИ.
 */
export function looksLikeCis(raw) {
  const s = normalizeCis(raw);
  if (!s) return false;
  if (/^\d{8,14}$/.test(s)) return false;
  if (s.startsWith('01') && s.length >= 16) return true;
  if (s.length >= 20) return true;
  return false;
}

/** Коды для поиска товара: сам скан или GTIN/EAN из КИ. */
export function productLookupCodesFromScan(raw) {
  const s = normalizeCis(raw);
  if (!s) return [];
  if (!looksLikeCis(s)) return [s];
  const gtin = extractGtinFromCis(s);
  if (!gtin) return [s];
  const codes = [gtin];
  if (gtin.length === 14 && gtin.startsWith('0')) codes.push(gtin.slice(1));
  if (gtin.length === 14 && gtin.startsWith('00')) codes.push(gtin.slice(2));
  return [...new Set(codes.filter(Boolean))];
}

export function cisStatusLabel(status) {
  if (status == null || status === '') return '';
  const key = String(status).toUpperCase();
  return CIS_STATUS_LABELS[key] || String(status);
}

export function parseJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  try {
    const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function tokenExpiryIso(token) {
  const payload = parseJwtPayload(token);
  const exp = payload?.exp != null ? Number(payload.exp) : NaN;
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return new Date(exp * 1000).toISOString();
}

export function isTokenExpired(token, nowMs = Date.now()) {
  const payload = parseJwtPayload(token);
  const exp = payload?.exp != null ? Number(payload.exp) : NaN;
  if (!Number.isFinite(exp) || exp <= 0) return false;
  return exp * 1000 <= nowMs;
}

export function buildTrueApiBaseUrl({ sandbox = false, api_version = 'v3', api_url = '' } = {}) {
  const custom = String(api_url || '').trim().replace(/\/+$/, '');
  if (custom) return custom;
  const v4 = String(api_version || 'v3').toLowerCase() === 'v4';
  if (sandbox) return v4 ? TRUE_API_SANDBOX_V4 : TRUE_API_SANDBOX_V3;
  return v4 ? TRUE_API_PROD_V4 : TRUE_API_PROD_V3;
}

export function parseIntegrationConfig(config) {
  if (!config) return {};
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof config === 'object' ? { ...config } : {};
}

export function isTokenPlaceholder(value) {
  const s = String(value ?? '').trim();
  if (!s) return true;
  return /^(?:\*+|•+|·+)[\s\w.-]{0,8}$/u.test(s);
}

export function toPublicChestnyZnakConfig(config) {
  const cfg = parseIntegrationConfig(config);
  const token = String(cfg.token || '').trim();
  const expiresAt = cfg.token_expires_at || tokenExpiryIso(token);
  const last4 = token.length >= 4 ? token.slice(-4) : '';
  const {
    token: _t,
    oms_token: _ot,
    ...rest
  } = cfg;
  const omsToken = String(cfg.oms_token || '').trim();
  return {
    ...rest,
    sandbox: Boolean(cfg.sandbox),
    is_active: cfg.is_active !== false,
    api_version: cfg.api_version === 'v4' ? 'v4' : 'v3',
    united_token: Boolean(cfg.united_token),
    product_groups: Array.isArray(cfg.product_groups)
      ? cfg.product_groups.map((x) => String(x)).filter(Boolean)
      : [],
    operations: normalizeOperations(cfg.operations),
    operationOptions: CHESTNY_ZNAK_OPERATIONS,
    token_set: Boolean(token),
    token_preview: token ? `••••${last4}` : '',
    token_expires_at: expiresAt || null,
    oms_token_set: Boolean(omsToken),
    productGroupOptions: CHESTNY_ZNAK_PRODUCT_GROUPS,
  };
}

export function mapCisInfoEntry(entry) {
  const raw = entry && typeof entry === 'object' ? entry : {};
  const info = raw.cisInfo && typeof raw.cisInfo === 'object' ? raw.cisInfo : raw;
  const cis = normalizeCis(raw.cis || info.cis || '');
  const status = info.status || info.cisStatus || raw.status || '';
  const errorCode = raw.errorCode != null ? String(raw.errorCode) : '';
  const errorMessage = raw.errorMessage || raw.error_message || '';
  const ok = !errorCode || errorCode === '0';
  return {
    cis,
    gtin: info.gtin || extractGtinFromCis(cis) || null,
    status,
    status_label: cisStatusLabel(status),
    product_group: info.productGroup || info.productGroupId || info.pg || '',
    product_name: info.productName || info.name || '',
    owner_inn: info.ownerInn || info.inn || '',
    producer_inn: info.producerInn || '',
    package_type: info.packageType || '',
    error_code: ok ? '' : errorCode,
    error_message: ok ? '' : errorMessage,
    ok,
    raw: info,
  };
}

export function mapCisInfoResponse(payload) {
  if (Array.isArray(payload)) return payload.map(mapCisInfoEntry);
  if (payload && Array.isArray(payload.result)) return payload.result.map(mapCisInfoEntry);
  if (payload && Array.isArray(payload.cisInfo)) return payload.cisInfo.map(mapCisInfoEntry);
  return [];
}
