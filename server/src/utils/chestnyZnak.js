/**
 * Честный знак (ГИС МТ / True API): справочники, нормализация КИ, публичный конфиг.
 */

export const CHESTNY_ZNAK_CODE = 'chestny_znak';
export const CHESTNY_ZNAK_TYPE = 'other';

export const TRUE_API_PROD_V3 = 'https://markirovka.crpt.ru/api/v3/true-api';
export const TRUE_API_PROD_V4 = 'https://markirovka.crpt.ru/api/v4/true-api';
export const TRUE_API_SANDBOX_V3 = 'https://markirovka.sandbox.crpt.ru/api/v3/true-api';
export const TRUE_API_SANDBOX_V4 = 'https://markirovka.sandbox.crpt.ru/api/v4/true-api';

/** Коды товарных групп True API (pg). Шины — основные для автозапчастей. */
export const CHESTNY_ZNAK_PRODUCT_GROUPS = [
  { id: 'tires', name: 'Шины' },
  { id: 'shoes', name: 'Обувь' },
  { id: 'lp', name: 'Одежда (лёгпром)' },
  { id: 'perfumery', name: 'Духи и туалетная вода' },
  { id: 'electronics', name: 'Фотокамеры и вспышки' },
  { id: 'milk', name: 'Молочная продукция' },
  { id: 'water', name: 'Упакованная вода' },
  { id: 'beer', name: 'Пиво' },
  { id: 'nabeer', name: 'Слабоалкогольные напитки' },
  { id: 'softdrinks', name: 'Безалкогольные напитки' },
  { id: 'tobacco', name: 'Табак' },
  { id: 'otp', name: 'Альтернативный табак' },
  { id: 'ncp', name: 'Никотинсодержащая продукция' },
  { id: 'bio', name: 'БАД' },
  { id: 'antiseptic', name: 'Антисептики' },
  { id: 'medical', name: 'Медизделия' },
  { id: 'pharma', name: 'Лекарства' },
  { id: 'petfood', name: 'Корма для животных' },
  { id: 'seafood', name: 'Морепродукты' },
  { id: 'conserve', name: 'Консервы' },
  { id: 'vegetableoil', name: 'Растительные масла' },
  { id: 'bicycle', name: 'Велосипеды' },
  { id: 'wheelchairs', name: 'Кресла-коляски' },
];

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
