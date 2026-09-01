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

function cloneFunctions(functions) {
  return Array.isArray(functions) && functions.length ? functions : null;
}

function stateIdOf(msg) {
  return msg?.functions_state_id || msg?.tools_state_id || msg?.tool_state_id || null;
}

function parseJsonContent(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  if (typeof content !== 'string') return { result: content ?? null };
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : { result: parsed };
  } catch {
    return { result: content };
  }
}

function stripMessage(raw) {
  const msg = raw && typeof raw === 'object' ? raw : {};
  const out = {
    role: msg.role,
    content: msg.content == null ? '' : msg.content,
  };
  if (msg.name) out.name = msg.name;
  if (msg.function_call) out.function_call = msg.function_call;
  const stateId = stateIdOf(msg);
  if (stateId) {
    out.functions_state_id = stateId;
    out.tools_state_id = stateId;
  }
  return out;
}

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/** Схемы инструментов только на user — не на assistant и не на результат function. */
function withFunctionsOnUser(messages, functions) {
  const list = (Array.isArray(messages) ? messages : []).map(stripMessage);
  const fns = cloneFunctions(functions);
  const idx = lastUserIndex(list);
  if (!fns || idx < 0) return list;
  list[idx] = { ...list[idx], functions: fns };
  return list;
}

function toToolsApiMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((raw) => {
    const msg = stripMessage(raw);
    if (msg.role === 'function' || msg.role === 'tool') {
      const name = msg.name || msg.function_call?.name || '';
      const result = parseJsonContent(msg.content);
      const out = {
        role: 'tool',
        content: [{ function_result: { name, result } }],
      };
      const sid = stateIdOf(msg);
      if (sid) out.tools_state_id = sid;
      return out;
    }
    if (msg.role === 'assistant' && msg.function_call) {
      const out = {
        role: 'assistant',
        content: msg.content || '',
        function_call: msg.function_call,
      };
      const sid = stateIdOf(msg);
      if (sid) out.tools_state_id = sid;
      return out;
    }
    return msg;
  });
}

function isRetryableChatError(err) {
  return /thinking_functions|functions or thinking|should only appeal|every assistant function call must have a result/i.test(
    String(err?.message || '')
  );
}

function normalizeChatCompletion(json) {
  if (!json || typeof json !== 'object') return json;
  if (Array.isArray(json.choices) && json.choices.length) return json;
  const messages = Array.isArray(json.messages) ? json.messages : [];
  if (!messages.length) return json;
  const message = messages[messages.length - 1] || {};
  const finish =
    json.finish_reason ||
    (message.function_call?.name ? 'function_call' : 'stop');
  return {
    ...json,
    choices: [{ message, index: 0, finish_reason: finish }],
  };
}

export async function gigachatChatCompletions(settings, payload) {
  const src = payload && typeof payload === 'object' ? { ...payload } : {};
  const functions = cloneFunctions(src.functions);
  delete src.functions;

  const attempts = [];
  if (functions) {
    attempts.push({
      label: 'functions-on-user',
      body: {
        ...src,
        function_call: src.function_call || 'auto',
        messages: withFunctionsOnUser(src.messages, functions),
      },
    });
    attempts.push({
      label: 'tools-spec',
      body: (() => {
        const body = {
          ...src,
          messages: toToolsApiMessages(src.messages),
          tools: [{ functions: { specifications: functions } }],
          tool_config: { mode: 'auto' },
        };
        delete body.function_call;
        return body;
      })(),
    });
  } else {
    attempts.push({
      label: 'plain',
      body: { ...src, messages: (src.messages || []).map(stripMessage) },
    });
  }

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const json = await gigachatRequest({
        credentials: settings.credentials,
        scope: settings.scope,
        apiBase: settings.apiBase,
        path: '/chat/completions',
        method: 'POST',
        body: attempt.body,
      });
      return normalizeChatCompletion(json);
    } catch (err) {
      lastErr = err;
      logger.warn('[GigaChat] chat attempt failed', {
        label: attempt.label,
        message: String(err?.message || err).slice(0, 240),
        roles: (attempt.body.messages || []).map((m) => m.role),
      });
      if (!functions || !isRetryableChatError(err)) throw err;
    }
  }
  throw lastErr;
}
