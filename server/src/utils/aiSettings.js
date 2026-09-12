/**
 * Настройки ИИ-ассистента аккаунта (сейчас — GigaChat).
 */

export const AI_PROVIDER_GIGACHAT = 'gigachat';

export const GIGACHAT_SCOPES = [
  'GIGACHAT_API_PERS',
  'GIGACHAT_API_B2B',
  'GIGACHAT_API_CORP',
];

export const GIGACHAT_MODELS = [
  { id: 'GigaChat-2', label: 'GigaChat 2 Lite' },
  { id: 'GigaChat-2-Pro', label: 'GigaChat 2 Pro' },
  { id: 'GigaChat-2-Max', label: 'GigaChat 2 Max' },
  { id: 'GigaChat-3-Ultra', label: 'GigaChat 3 Ultra' },
];

export const GIGACHAT_API_BASES = [
  { id: 'https://api.giga.chat/v1', label: 'api.giga.chat (рекомендуется)' },
  { id: 'https://gigachat.devices.sberbank.ru/api/v1', label: 'gigachat.devices.sberbank.ru (старый)' },
];

export const DEFAULT_GIGACHAT_API_BASE = GIGACHAT_API_BASES[0].id;
export const DEFAULT_GIGACHAT_MODEL = 'GigaChat-2-Max';
export const DEFAULT_GIGACHAT_SCOPE = 'GIGACHAT_API_PERS';
export const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
export const CREDENTIALS_PLACEHOLDER = '********';

const EDITOR_TEMPLATES_MAX = 40;
const EDITOR_TEMPLATE_NAME_MAX = 80;
const EDITOR_TEMPLATE_PROMPT_MAX = 2000;
const EDITOR_TEMPLATE_KEYS_MAX = 80;

function strKeyList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const k = String(item || '').trim().slice(0, 80);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= EDITOR_TEMPLATE_KEYS_MAX) break;
  }
  return out;
}

export function normalizeAiEditorTemplates(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = String(item.id || '').trim().slice(0, 64) || `t_${Date.now()}_${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = String(item.name || '').trim().slice(0, EDITOR_TEMPLATE_NAME_MAX) || 'Шаблон';
    out.push({
      id,
      name,
      prompt: String(item.prompt ?? '').slice(0, EDITOR_TEMPLATE_PROMPT_MAX),
      outputKeys: strKeyList(item.outputKeys),
      contextKeys: strKeyList(item.contextKeys),
      fillEmptyOnly: item.fillEmptyOnly !== false,
    });
    if (out.length >= EDITOR_TEMPLATES_MAX) break;
  }
  return out;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export { httpError as aiHttpError };

function parseObject(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function parseAiSettings(raw) {
  const src = parseObject(raw);
  const scope = GIGACHAT_SCOPES.includes(String(src.scope || '').trim())
    ? String(src.scope).trim()
    : DEFAULT_GIGACHAT_SCOPE;
  const modelIds = GIGACHAT_MODELS.map((m) => m.id);
  const model = modelIds.includes(String(src.model || '').trim())
    ? String(src.model).trim()
    : DEFAULT_GIGACHAT_MODEL;
  const apiBaseRaw = String(src.apiBase || src.api_base || '').trim().replace(/\/+$/, '');
  const apiBase =
    GIGACHAT_API_BASES.some((b) => b.id === apiBaseRaw) || /^https:\/\//i.test(apiBaseRaw)
      ? apiBaseRaw || DEFAULT_GIGACHAT_API_BASE
      : DEFAULT_GIGACHAT_API_BASE;
  const credentials = String(src.credentials || '').trim();
  const enabled = src.enabled !== false && src.enabled !== 'false';
  return {
    provider: AI_PROVIDER_GIGACHAT,
    credentials,
    scope,
    model,
    apiBase,
    enabled,
    editorTemplates: normalizeAiEditorTemplates(src.editorTemplates ?? src.editor_templates),
  };
}

export function toPublicAiSettings(raw) {
  const s = parseAiSettings(raw);
  const credentialsSet = Boolean(s.credentials);
  return {
    provider: AI_PROVIDER_GIGACHAT,
    configured: credentialsSet,
    credentialsSet,
    credentials: credentialsSet ? CREDENTIALS_PLACEHOLDER : '',
    enabled: credentialsSet ? s.enabled : false,
    model: s.model,
    scope: s.scope,
    apiBase: s.apiBase,
    editorTemplates: s.editorTemplates || [],
  };
}

export function mergeAiSettings(existingRaw, incoming = {}) {
  const existing = parseAiSettings(existingRaw);
  const next = { ...existing };
  if (incoming.scope !== undefined) {
    const scope = String(incoming.scope || '').trim();
    if (!GIGACHAT_SCOPES.includes(scope)) {
      throw aiHttpError('Неизвестный scope GigaChat');
    }
    next.scope = scope;
  }
  if (incoming.model !== undefined) {
    const model = String(incoming.model || '').trim();
    if (!GIGACHAT_MODELS.some((m) => m.id === model)) {
      throw aiHttpError('Неизвестная модель GigaChat');
    }
    next.model = model;
  }
  if (incoming.apiBase !== undefined || incoming.api_base !== undefined) {
    const apiBase = String(incoming.apiBase || incoming.api_base || '')
      .trim()
      .replace(/\/+$/, '');
    if (!apiBase) throw aiHttpError('Укажите адрес API');
    next.apiBase = apiBase;
  }
  if (incoming.enabled !== undefined) {
    next.enabled = incoming.enabled !== false && incoming.enabled !== 'false';
  }
  if (incoming.credentials !== undefined) {
    const cred = String(incoming.credentials || '').trim();
    if (cred && cred !== CREDENTIALS_PLACEHOLDER) {
      next.credentials = cred.replace(/^Basic\s+/i, '').trim();
    }
  }
  if (incoming.editorTemplates !== undefined || incoming.editor_templates !== undefined) {
    next.editorTemplates = normalizeAiEditorTemplates(
      incoming.editorTemplates ?? incoming.editor_templates
    );
  }
  next.provider = AI_PROVIDER_GIGACHAT;
  return next;
}

export function assertAiReady(raw) {
  const s = parseAiSettings(raw);
  if (!s.credentials) {
    throw aiHttpError(
      'GigaChat не настроен. Откройте Интеграции → Остальное → GigaChat и вставьте ключ авторизации.',
      400
    );
  }
  if (!s.enabled) {
    throw aiHttpError('GigaChat выключен в настройках интеграции.', 400);
  }
  return s;
}
