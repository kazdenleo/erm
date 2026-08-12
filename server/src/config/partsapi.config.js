/**
 * Конфиг PartsAPI (обогащение карточек автозапчастей).
 * Приоритет ключей: keys профиля аккаунта → env/файл (fallback).
 */

/** Методы рабочего пакета обогащения */
export const PARTSAPI_ENRICHMENT_METHODS = [
  'searchArticles',
  'getArticle',
  'getArticleCriteria',
  'getArticleMedia',
  'getPartnameByBrandNumber',
  'getPartWeight',
  'FindEAN13',
];

/** Подписи для UI настроек аккаунта */
export const PARTSAPI_METHOD_LABELS = {
  searchArticles: 'Поиск по артикулу (searchArticles)',
  getArticle: 'Карточка артикула (getArticle)',
  getArticleCriteria: 'Характеристики (getArticleCriteria)',
  getArticleMedia: 'Фото / медиа (getArticleMedia)',
  getPartnameByBrandNumber: 'Название (getPartnameByBrandNumber)',
  getPartWeight: 'Вес (getPartWeight)',
  FindEAN13: 'Штрихкод EAN (FindEAN13)',
};

/** Методы, которые реально вызываются в MVP-обогащении */
export const PARTSAPI_MVP_METHODS = [
  'searchArticles',
  'getArticleCriteria',
  'getArticleMedia',
  'getPartnameByBrandNumber',
  'getPartWeight',
  'FindEAN13',
];

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizePartsApiKeys(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const method of PARTSAPI_ENRICHMENT_METHODS) {
    const v = obj[method];
    if (v != null && String(v).trim()) out[method] = String(v).trim();
  }
  return out;
}

function loadKeysFromEnvJson() {
  const raw = String(process.env.PARTSAPI_KEYS || '').trim();
  if (!raw) return {};
  try {
    return normalizePartsApiKeys(JSON.parse(raw));
  } catch (err) {
    console.warn('[partsapi] Invalid PARTSAPI_KEYS JSON:', err?.message || err);
    return {};
  }
}

function resolveFallbackKeys() {
  const fromJson = loadKeysFromEnvJson();
  const fallback = String(process.env.PARTSAPI_KEY || '').trim();
  const keys = { ...fromJson };
  if (fallback) {
    for (const method of PARTSAPI_ENRICHMENT_METHODS) {
      if (!keys[method]) keys[method] = fallback;
    }
  }
  return keys;
}

/**
 * @param {Record<string, string>|null|undefined} [profileKeys]
 */
export function getPartsApiConfig(profileKeys = null) {
  const baseUrl = String(process.env.PARTSAPI_BASE_URL || 'https://api.partsapi.ru')
    .trim()
    .replace(/\/+$/, '');
  const mediaBaseUrl = String(process.env.PARTSAPI_MEDIA_BASE_URL || 'https://partsapi.ru')
    .trim()
    .replace(/\/+$/, '');
  const lang = Number(process.env.PARTSAPI_LANG || 16) || 16;
  const timeoutMs = Math.max(3000, Number(process.env.PARTSAPI_TIMEOUT_MS || 25000) || 25000);
  const profileNormalized = normalizePartsApiKeys(profileKeys);
  const keys = { ...resolveFallbackKeys(), ...profileNormalized };

  return {
    baseUrl,
    mediaBaseUrl,
    lang,
    timeoutMs,
    keys,
    configuredMethods: PARTSAPI_ENRICHMENT_METHODS.filter((m) => !!keys[m]),
  };
}

/**
 * @param {string} method
 * @param {Record<string, string>|null|undefined} [profileKeys]
 */
export function getPartsApiMethodKey(method, profileKeys = null) {
  const { keys } = getPartsApiConfig(profileKeys);
  return keys[method] || null;
}
