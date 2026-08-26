/**
 * Частичное обновление JSON-атрибутов товара.
 * Пустой объект не затирает БД; ключи, которых нет в патче, сохраняются.
 */

export function parseJsonObject(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function isEmptyAttrPatch(obj) {
  return obj == null || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).length === 0;
}

export function isEmptyJsonAttrValue(v) {
  if (v == null) return true;
  if (v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    if ('value' in v || 'dictionary_value_id' in v || 'id' in v) {
      const hasVal = v.value != null && String(v.value).trim() !== '';
      const hasDict = v.dictionary_value_id != null && String(v.dictionary_value_id).trim() !== '';
      const hasId = v.id != null && String(v.id).trim() !== '';
      return !hasVal && !hasDict && !hasId;
    }
    return Object.keys(v).length === 0;
  }
  return false;
}

/** Слить патч характеристик МП: пустое значение ключа удаляет его, остальные ключи БД не трогаем. */
export function mergeJsonAttrPatch(existing, incoming) {
  const base = parseJsonObject(existing);
  if (isEmptyAttrPatch(incoming)) return base;
  const next = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    if (isEmptyJsonAttrValue(v)) delete next[k];
    else next[k] = v;
  }
  return next;
}

/** Слить ozon/wb/ym_draft: пустой патч — no-op, иначе поверхностное слияние. */
export function mergeJsonObjectPatch(existing, incoming) {
  const base = parseJsonObject(existing);
  if (isEmptyAttrPatch(incoming)) return base;
  return { ...base, ...incoming };
}
