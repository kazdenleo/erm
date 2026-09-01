/**
 * Клиент GigaChat API: OAuth + chat/completions с function calling.
 */

import crypto from 'crypto';
import { gigachatFetch } from '../utils/gigachatHttps.js';
import { GIGACHAT_OAUTH_URL, aiHttpError } from '../utils/aiSettings.js';
import logger from '../utils/logger.js';

const tokenCache = new Map();

function cacheKey(credentials, scope) {
  return crypto.createHash('sha256').update(`${credentials}|${scope}`).digest('hex');
}

function parseExpiresAt(payload) {
  const raw = payload?.expires_at ?? payload?.expiresAt;
  if (raw == null) {
    const sec = Number(payload?.expires_in);
    if (Number.isFinite(sec) && sec > 0) return Date.now() + sec * 1000;
    return Date.now() + 25 * 60 * 1000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now() + 25 * 60 * 1000;
  return n > 1e12 ? n : n * 1000;
}

function authHeader(credentials) {
  const key = String(credentials || '').replace(/^Basic\s+/i, '').trim();
  return `Basic ${key}`;
}

async function readErrorText(res) {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return json.message || json.error_description || json.error || text;
  } catch {
    return text.slice(0, 500);
  }
}

export async function getGigachatAccessToken({ credentials, scope }) {
  const key = cacheKey(credentials, scope);
  const cached = tokenCache.get(key);
  if (cached?.token && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const res = await gigachatFetch(GIGACHAT_OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      RqUID: crypto.randomUUID(),
      Authorization: authHeader(credentials),
    },
    body: new URLSearchParams({ scope }).toString(),
  });

  if (!res.ok) {
    const detail = await readErrorText(res);
    logger.warn('[GigaChat] OAuth failed', { status: res.status, detail: String(detail).slice(0, 300) });
    const err = aiHttpError(
      res.status === 401 || res.status === 403
        ? `GigaChat отклонил ключ авторизации (${res.status}). Проверьте ключ и scope (PERS / B2B / CORP).`
        : `Не удалось получить токен GigaChat (${res.status}): ${detail || res.statusText}`,
      res.status === 401 || res.status === 403 ? 400 : 502
    );
    throw err;
  }

  const payload = await res.json();
  const token = String(payload.access_token || payload.tok || '').trim();
  if (!token) {
    throw aiHttpError('GigaChat не вернул access_token', 502);
  }
  tokenCache.set(key, { token, expiresAt: parseExpiresAt(payload) });
  return token;
}

export async function gigachatRequest({ credentials, scope, apiBase, path, method = 'GET', body = null }) {
  const token = await getGigachatAccessToken({ credentials, scope });
  const url = `${String(apiBase).replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await gigachatFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = json?.message || json?.error || text.slice(0, 500) || res.statusText;
    logger.warn('[GigaChat] API error', { status: res.status, path, detail: String(detail).slice(0, 300) });
    throw aiHttpError(`Ошибка GigaChat (${res.status}): ${detail}`, res.status >= 500 ? 502 : 400);
  }
  return json;
}

export async function gigachatListModels(settings) {
  return gigachatRequest({
    credentials: settings.credentials,
    scope: settings.scope,
    apiBase: settings.apiBase,
    path: '/models',
  });
}

export async function gigachatChatCompletions(settings, payload) {
  return gigachatRequest({
    credentials: settings.credentials,
    scope: settings.scope,
    apiBase: settings.apiBase,
    path: '/chat/completions',
    method: 'POST',
    body: payload,
  });
}
