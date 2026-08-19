/**
 * Связь ERP-атрибута с характеристиками Ozon / WB / Яндекс.Маркета.
 * Формат: { ozon?: [{ id, name }, ...], wb?: [...], ym?: [...] }
 * Старый формат { ozon: { id, name } } читается как массив из одного элемента.
 */

export const MP_LINK_CODES = ['ozon', 'wb', 'ym'];

function linkKey(entry) {
  if (!entry) return '';
  if (entry.id) return `id:${entry.id}`;
  if (entry.name) return `name:${String(entry.name).trim().toLowerCase()}`;
  return '';
}

function normalizeMpLinkEntry(raw) {
  if (raw == null || raw === '' || raw === false) return null;
  if (raw === true) return { id: '', name: 'Основное' };
  if (Array.isArray(raw)) return normalizeMpLinkEntry(raw[0]);
  if (typeof raw === 'string' || typeof raw === 'number') {
    const s = String(raw).trim();
    if (!s) return null;
    return /^\d+$/.test(s) ? { id: s, name: '' } : { id: '', name: s };
  }
  if (typeof raw !== 'object') return null;
  const id = raw.id != null && raw.id !== '' ? String(raw.id).trim() : '';
  const name = String(raw.name || raw.title || '').trim();
  if (!id && !name) return null;
  return { id, name };
}

function normalizeMpLinkList(raw) {
  if (raw == null || raw === '' || raw === false) return [];
  if (raw === true) return [{ id: '', name: 'Основное' }];
  const items = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const e = normalizeMpLinkEntry(item);
    if (!e) continue;
    const k = linkKey(e);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export function normalizeMpLinks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const mp of MP_LINK_CODES) {
    const list = normalizeMpLinkList(raw[mp]);
    if (list.length) out[mp] = list;
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
