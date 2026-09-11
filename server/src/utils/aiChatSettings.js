const PROMPT_MAX = 2000;
const KEYS_MAX = 40;
const KEY_LEN = 80;

function strList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const k = String(item || '').trim().slice(0, KEY_LEN);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= KEYS_MAX) break;
  }
  return out;
}

export function normalizeAiChatSettings(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    outputKeys: strList(raw.outputKeys),
    contextKeys: strList(raw.contextKeys),
    fillEmptyOnly: raw.fillEmptyOnly !== false,
    prompt: String(raw.prompt ?? '').slice(0, PROMPT_MAX),
  };
}
