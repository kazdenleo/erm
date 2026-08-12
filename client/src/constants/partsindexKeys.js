/** Ключ PartsIndex для UI настроек аккаунта. Документация: https://api.parts-index.com/docs/ru/#/ */

export function emptyPartsIndexKeysForm() {
  return { apiKey: '' };
}

export function partsIndexKeysFromProfile(raw) {
  const base = emptyPartsIndexKeysForm();
  let obj = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return base;
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
  if (!obj || typeof obj !== 'object') return base;
  const apiKey = String(obj.apiKey ?? obj.api_key ?? obj.key ?? '').trim();
  return { apiKey };
}
