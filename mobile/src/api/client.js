/**
 * HTTP-клиент ERP API: Bearer-токен и контекст аккаунта/организации,
 * как в веб-клиенте (client/src/services/api.js).
 */

const state = {
  baseUrl: '',
  token: null,
  accountId: null,
  organizationId: null,
  onUnauthorized: null,
};

export class ApiError extends Error {
  constructor(message, status = 0, code = null, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** «192.168.1.10:3001» → «http://192.168.1.10:3001/api» */
export function normalizeServerUrl(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  if (!/\/api$/i.test(s)) s = `${s}/api`;
  return s;
}

export function configureApi(patch) {
  Object.assign(state, patch);
}

export function getApiBaseUrl() {
  return state.baseUrl;
}

export function authHeaders({ withContext = true } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (withContext) {
    if (state.accountId) headers['X-Account-Id'] = String(state.accountId);
    if (state.organizationId) headers['X-Organization-Id'] = String(state.organizationId);
  }
  return headers;
}

export function apiUrl(path, params) {
  const url = `${state.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  if (!params) return url;
  const query = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return query ? `${url}?${query}` : url;
}

export async function request(
  path,
  { method = 'GET', body, params, timeoutMs = 30000, withContext = true } = {}
) {
  if (!state.baseUrl) throw new ApiError('Не указан адрес сервера');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(apiUrl(path, params), {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders({ withContext }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(
      controller.signal.aborted ? 'Сервер не ответил вовремя' : 'Нет связи с сервером. Проверьте адрес и сеть.'
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok || json?.ok === false) {
    const message = json?.message || json?.error || `Ошибка сервера (HTTP ${res.status})`;
    if (res.status === 401 && state.token) state.onUnauthorized?.(message);
    throw new ApiError(message, res.status, json?.code ?? null, json);
  }
  return json;
}

export function errorMessage(err, fallback = 'Что-то пошло не так') {
  return err?.message ? String(err.message) : fallback;
}
