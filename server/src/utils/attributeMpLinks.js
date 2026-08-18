/**
 * Связь ERP-атрибута с характеристиками Ozon / WB / Яндекс.Маркета.
 * Формат: { ozon?: { id, name }, wb?: { id, name }, ym?: { id, name } }
 */

export const MP_LINK_CODES = ['ozon', 'wb', 'ym'];

export function normalizeMpLinks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const mp of MP_LINK_CODES) {
    const v = raw[mp];
    if (v == null || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      if (!s) continue;
      out[mp] = /^\d+$/.test(s) ? { id: s, name: '' } : { id: '', name: s };
      continue;
    }
    if (typeof v !== 'object') continue;
    const id = v.id != null && v.id !== '' ? String(v.id).trim() : '';
    const name = String(v.name || v.title || '').trim();
    if (!id && !name) continue;
    out[mp] = { id, name };
  }
  return out;
}

/** Карта { [attributeId]: mp_links } на категории. */
export function normalizeAttributeMpLinksMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (key == null || String(key).trim() === '') continue;
    out[String(key)] = normalizeMpLinks(value);
  }
  return out;
}
