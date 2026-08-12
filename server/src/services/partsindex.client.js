/**
 * HTTP-клиент PartsIndex API.
 * Base: https://api.parts-index.com
 * Auth: заголовок Authorization = API key (scopes access + info / relations / old-apply).
 */

import { getPartsIndexConfig } from '../config/partsindex.config.js';

export class PartsIndexError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string|number, body?: unknown }} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'PartsIndexError';
    this.status = extra.status ?? 0;
    this.code = extra.code ?? null;
    this.body = extra.body ?? null;
  }
}

/**
 * @param {string} apiKey
 */
function authHeaderValue(apiKey) {
  const k = String(apiKey || '').trim();
  if (!k) return '';
  if (/^bearer\s+/i.test(k)) return k;
  return k;
}

/**
 * @param {string} path
 * @param {Record<string, string|number|undefined|null>} query
 * @param {{ apiKey?: string, baseUrl?: string, timeoutMs?: number }|null} [cfgOverride]
 */
export async function partsIndexGet(path, query = {}, cfgOverride = null) {
  const cfg = { ...getPartsIndexConfig(), ...(cfgOverride || {}) };
  if (!cfg.apiKey) {
    throw new PartsIndexError('Не задан API-ключ PartsIndex', { status: 0, code: 'NO_KEY' });
  }
  const url = new URL(path.startsWith('http') ? path : `${cfg.baseUrl}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: authHeaderValue(cfg.apiKey),
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new PartsIndexError('Таймаут запроса PartsIndex', { status: 504, code: 'TIMEOUT' });
    }
    throw new PartsIndexError(err?.message || String(err), { status: 502, code: 'NETWORK' });
  }
  clearTimeout(timer);

  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    let msg =
      (body && typeof body === 'object' && (body.message || body.error || body.Message)) ||
      `PartsIndex HTTP ${res.status}`;
    // code 1003: ключ принят, но нет доступа (тариф / scopes access+info)
    if (res.status === 403 || body?.code === 1003 || /access deny/i.test(String(msg))) {
      msg =
        `${msg}. Проверьте в кабинете PartsIndex, что ключ активен и есть scopes ` +
        `«access» и «info» (для /v1/entities). Без тарифа на «Информацию о детали» API вернёт deny.`;
    }
    throw new PartsIndexError(String(msg), {
      status: res.status,
      code: body?.code ?? res.status,
      body,
    });
  }

  return body;
}

/**
 * Информация о детали по артикулу (+ бренд).
 * GET /v1/entities?code=&brand=&lang=
 * @param {string} code
 * @param {string} [brand]
 * @param {{ apiKey?: string, lang?: string }} [opts]
 */
export async function getEntities(code, brand = '', opts = {}) {
  const cfg = getPartsIndexConfig(opts.apiKey ? { apiKey: opts.apiKey } : null);
  const lang = opts.lang || cfg.lang || 'ru';
  const raw = await partsIndexGet(
    '/v1/entities',
    { code: String(code || '').trim(), brand: String(brand || '').trim() || undefined, lang },
    { apiKey: opts.apiKey || cfg.apiKey, lang }
  );
  const list = Array.isArray(raw?.list) ? raw.list : Array.isArray(raw) ? raw : [];
  return { list, raw };
}

/**
 * Бренды, выпускающие артикул.
 * GET /v1/brands/by-part-code?code=
 */
export async function getBrandsByPartCode(code, opts = {}) {
  const cfg = getPartsIndexConfig(opts.apiKey ? { apiKey: opts.apiKey } : null);
  const raw = await partsIndexGet(
    '/v1/brands/by-part-code',
    { code: String(code || '').trim() },
    { apiKey: opts.apiKey || cfg.apiKey }
  );
  const list = Array.isArray(raw?.list) ? raw.list : Array.isArray(raw) ? raw : [];
  return { list, raw };
}

/**
 * Нормализация названия бренда / синонимы.
 * GET /v1/brands/parse?q=
 */
export async function parseBrand(query, opts = {}) {
  const cfg = getPartsIndexConfig(opts.apiKey ? { apiKey: opts.apiKey } : null);
  const raw = await partsIndexGet(
    '/v1/brands/parse',
    { q: String(query || '').trim() },
    { apiKey: opts.apiKey || cfg.apiKey }
  );
  return { brand: raw && typeof raw === 'object' ? raw : null, raw };
}

/**
 * Аналоги / связанные детали.
 * GET /v1/relations?code=&brand= или ?id=
 */
export async function getRelations({ id, code, brand, types } = {}, opts = {}) {
  const cfg = getPartsIndexConfig(opts.apiKey ? { apiKey: opts.apiKey } : null);
  const raw = await partsIndexGet(
    '/v1/relations',
    {
      id: id || undefined,
      code: code || undefined,
      brand: brand || undefined,
      types: types || undefined,
    },
    { apiKey: opts.apiKey || cfg.apiKey }
  );
  const list = Array.isArray(raw?.list) ? raw.list : Array.isArray(raw) ? raw : [];
  return { list, raw };
}

/**
 * Применимость к автомобилям (scope old-apply).
 * GET /v1/cars?code=&brand=
 */
export async function getCarsByPart(code, brand, opts = {}) {
  const cfg = getPartsIndexConfig(opts.apiKey ? { apiKey: opts.apiKey } : null);
  const lang = opts.lang || cfg.lang || 'ru';
  const raw = await partsIndexGet(
    '/v1/cars',
    {
      code: String(code || '').trim(),
      brand: String(brand || '').trim(),
      lang,
    },
    { apiKey: opts.apiKey || cfg.apiKey }
  );
  const list = Array.isArray(raw?.list) ? raw.list : Array.isArray(raw) ? raw : [];
  return { list, raw };
}

export default {
  partsIndexGet,
  getEntities,
  getBrandsByPartCode,
  parseBrand,
  getRelations,
  getCarsByPart,
  PartsIndexError,
};
