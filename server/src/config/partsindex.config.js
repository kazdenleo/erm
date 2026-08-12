/**
 * Конфиг PartsIndex API (обогащение карточек).
 * Документация: https://api.parts-index.com/docs/ru/#/
 * Приоритет ключа: keys профиля → PARTSINDEX_API_KEY / PARTSINDEX_KEY в env.
 */

/**
 * @param {unknown} raw
 * @returns {{ apiKey: string }}
 */
export function normalizePartsIndexKeys(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return { apiKey: '' };
    if (s.startsWith('{')) {
      try {
        obj = JSON.parse(s);
      } catch {
        return { apiKey: s };
      }
    } else {
      return { apiKey: s };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { apiKey: '' };
  const apiKey = String(
    obj.apiKey ?? obj.api_key ?? obj.key ?? obj.token ?? obj.Authorization ?? ''
  ).trim();
  return { apiKey };
}

/**
 * @param {{ apiKey?: string }|null|undefined} profileKeys
 */
export function getPartsIndexConfig(profileKeys = null) {
  const fromProfile = normalizePartsIndexKeys(profileKeys);
  const fromEnv = String(
    process.env.PARTSINDEX_API_KEY || process.env.PARTSINDEX_KEY || ''
  ).trim();
  const apiKey = fromProfile.apiKey || fromEnv;
  const baseUrl = String(process.env.PARTSINDEX_BASE_URL || 'https://api.parts-index.com')
    .trim()
    .replace(/\/+$/, '');
  const lang = String(process.env.PARTSINDEX_LANG || 'ru').trim() || 'ru';
  const timeoutMs = Math.max(
    3000,
    Number(process.env.PARTSINDEX_TIMEOUT_MS || 30000) || 30000
  );
  return {
    apiKey,
    baseUrl,
    lang,
    timeoutMs,
    configured: !!apiKey,
  };
}

export default {
  normalizePartsIndexKeys,
  getPartsIndexConfig,
};
