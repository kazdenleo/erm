import { productAttributesApi } from '../services/productAttributes.api.js';

export const AI_CHAT_PROMPT_MAX = 2000;

export function parseAiChatSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!src) return null;
  return {
    outputKeys: Array.isArray(src.outputKeys)
      ? src.outputKeys.map((k) => String(k || '').trim()).filter(Boolean)
      : [],
    contextKeys: Array.isArray(src.contextKeys)
      ? src.contextKeys.map((k) => String(k || '').trim()).filter(Boolean)
      : [],
    fillEmptyOnly: src.fillEmptyOnly !== false,
    prompt: String(src.prompt ?? ''),
  };
}

export function pickAiChatSettings(raw, { allowOutput = [], allowContext = [], defaultOutput = [], defaultContext = [] } = {}) {
  const parsed = parseAiChatSettings(raw) || { outputKeys: [], contextKeys: [], fillEmptyOnly: true, prompt: '' };
  const allowOut = new Set((allowOutput || []).map(String));
  const allowCtx = new Set((allowContext || []).map(String));
  const outputKeys = (parsed.outputKeys || []).filter((k) => allowOut.has(k));
  const contextKeys = allowCtx.size
    ? (parsed.contextKeys || []).filter((k) => allowCtx.has(k))
    : [...(parsed.contextKeys || [])];
  return {
    outputKeys: outputKeys.length ? outputKeys : [...defaultOutput],
    contextKeys: contextKeys.length ? contextKeys : [...defaultContext],
    fillEmptyOnly: parsed.fillEmptyOnly !== false,
    prompt: String(parsed.prompt || '').slice(0, AI_CHAT_PROMPT_MAX),
  };
}

export function attrAiChatSettingsRaw(attr) {
  return attr?.ai_chat_settings ?? attr?.aiChatSettings ?? null;
}

export function aiChatSettingsKey(attr) {
  return `${attr?.id ?? ''}:${JSON.stringify(attrAiChatSettingsRaw(attr) || null)}`;
}

export async function saveAttributeAiChatSettings(attributeId, payload) {
  const id = attributeId != null ? String(attributeId).trim() : '';
  if (!id) throw new Error('Нет атрибута для сохранения настроек ИИ');
  const res = await productAttributesApi.update(id, { ai_chat_settings: payload });
  return res?.data ?? res;
}

export function mergeUpdatedAttribute(list, attr) {
  if (!attr?.id) return list;
  const id = String(attr.id);
  const arr = Array.isArray(list) ? list : [];
  let found = false;
  const next = arr.map((a) => {
    if (String(a?.id) !== id) return a;
    found = true;
    return { ...a, ...attr };
  });
  return found ? next : [...next, attr];
}
