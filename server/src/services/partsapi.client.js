/**
 * HTTP-клиент PartsAPI.ru
 */

import { getPartsApiConfig, getPartsApiMethodKey } from '../config/partsapi.config.js';

function asArray(data) {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object') {
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.result)) return data.result;
    if (Array.isArray(data.items)) return data.items;
    return [data];
  }
  return [];
}

function looksLikeErrorPayload(data) {
  if (data == null) return false;
  if (Array.isArray(data)) return false;
  if (typeof data === 'string') {
    const s = data.toLowerCase();
    return s.includes('error') || s.includes('invalid') || s.includes('unauthorized');
  }
  if (typeof data === 'object') {
    if (data.error || data.Error || data.ERROR) return true;
    if (data.status === 'error' || data.success === false) return true;
  }
  return false;
}

export class PartsApiError extends Error {
  constructor(message, { method, status, body } = {}) {
    super(message);
    this.name = 'PartsApiError';
    this.method = method;
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {string} method
 * @param {Record<string, string|number|boolean|null|undefined>} params
 * @param {{ profileKeys?: Record<string, string>|null }} [options]
 */
export async function partsApiCall(method, params = {}, options = {}) {
  const profileKeys = options.profileKeys || null;
  const cfg = getPartsApiConfig(profileKeys);
  const key = getPartsApiMethodKey(method, profileKeys);
  if (!key) {
    throw new PartsApiError(
      `Нет ключа PartsAPI для метода ${method}. Укажите его в Настройках аккаунта → Обогащение карточек.`,
      { method, status: 0 }
    );
  }

  const qs = new URLSearchParams();
  qs.set('method', method);
  qs.set('key', key);
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    qs.set(k, String(v));
  }

  // Актуальный endpoint: https://api.partsapi.ru/?method=NAME&key=...&PARAMS
  // (старый partsapi.ru/api/NAME редиректит без method → «Incoming query parameters are missing»)
  const base = String(cfg.baseUrl || 'https://api.partsapi.ru').replace(/\/+$/, '');
  const url = `${base}/?${qs.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new PartsApiError(`Таймаут PartsAPI (${method})`, { method, status: 408 });
    }
    throw new PartsApiError(err?.message || `Сеть PartsAPI (${method})`, { method });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && (data.message || data.error || data.Error)) ||
      `HTTP ${res.status} PartsAPI ${method}`;
    throw new PartsApiError(String(msg), { method, status: res.status, body: data });
  }

  // PartsAPI часто отдаёт 200 с code/error_code и текстом ошибки
  if (
    data &&
    typeof data === 'object' &&
    (data.code != null || data.error_code != null || data.status === 401 || data.status === 'error')
  ) {
    const msg = data.message || data.error || data.Error || `Ошибка PartsAPI ${method}`;
    throw new PartsApiError(String(msg), {
      method,
      status: Number(data.status) || res.status || 400,
      body: data,
    });
  }

  if (looksLikeErrorPayload(data)) {
    const msg =
      (typeof data === 'object' && (data.error || data.Error || data.message)) ||
      `Ошибка PartsAPI ${method}`;
    throw new PartsApiError(String(msg), { method, status: res.status, body: data });
  }

  return { raw: data, rows: asArray(data), config: cfg };
}

export function resolvePartsApiMediaUrl(source, mediaBaseUrl) {
  const s = String(source || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const base = String(mediaBaseUrl || 'https://partsapi.ru').replace(/\/+$/, '');
  return s.startsWith('/') ? `${base}${s}` : `${base}/${s}`;
}

function withKeys(profileKeys) {
  return { profileKeys: profileKeys || null };
}

export async function searchArticles(searchNumber, lang, profileKeys) {
  const cfg = getPartsApiConfig(profileKeys);
  return partsApiCall(
    'searchArticles',
    { SEARCH_NUMBER: searchNumber, LANG: lang ?? cfg.lang },
    withKeys(profileKeys)
  );
}

export async function getArticle(artNum, supId, lang, profileKeys) {
  const cfg = getPartsApiConfig(profileKeys);
  return partsApiCall(
    'getArticle',
    {
      ART_NUM: artNum,
      SUP_ID: supId,
      LANG: lang ?? cfg.lang,
    },
    withKeys(profileKeys)
  );
}

export async function getArticleCriteria(artId, lang, profileKeys) {
  const cfg = getPartsApiConfig(profileKeys);
  return partsApiCall(
    'getArticleCriteria',
    { ART_ID: artId, LANG: lang ?? cfg.lang },
    withKeys(profileKeys)
  );
}

export async function getArticleMedia(artId, lang, profileKeys) {
  const cfg = getPartsApiConfig(profileKeys);
  return partsApiCall(
    'getArticleMedia',
    { ART_ID: artId, LANG: lang ?? cfg.lang },
    withKeys(profileKeys)
  );
}

export async function getPartnameByBrandNumber(brand, number, lang, profileKeys) {
  const cfg = getPartsApiConfig(profileKeys);
  return partsApiCall(
    'getPartnameByBrandNumber',
    { brand, number, lang: lang ?? cfg.lang },
    withKeys(profileKeys)
  );
}

export async function getPartWeight(brand, number, profileKeys) {
  return partsApiCall('getPartWeight', { brand, number }, withKeys(profileKeys));
}

export async function findEan13(brand, number, profileKeys) {
  try {
    return await partsApiCall('FindEAN13', { brand, number }, withKeys(profileKeys));
  } catch (err) {
    if (err?.status === 400 || err?.status === 404) {
      return partsApiCall('FindEAN13', { BRAND: brand, NUMBER: number }, withKeys(profileKeys));
    }
    throw err;
  }
}
