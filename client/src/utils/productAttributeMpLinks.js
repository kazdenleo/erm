/**
 * Связь ERP-атрибута с характеристиками Ozon / WB / Яндекс.Маркета.
 * mp_links: { ozon?: [{ id, name }, ...], wb?: [...], ym?: [...] }
 * Старый формат { ozon: { id, name } } читается как массив из одного элемента.
 */

import { attrValuesDiffer, normalizeAttrCompareName } from './productAttrMpDiff.js';
import { isYmOfferFieldAttrId } from './productMpFieldLinks.js';

export const ATTR_MP_CODES = ['ozon', 'wb', 'ym'];

export function emptyAttrMpLinks() {
  return { ozon: [], wb: [], ym: [] };
}

export function normalizeAttrMpLinkEntry(raw) {
  if (raw == null || raw === '' || raw === false) return null;
  if (raw === true) return { id: '', name: 'Основное' };
  if (Array.isArray(raw)) return normalizeAttrMpLinkEntry(raw[0]);
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

export function attrMpLinkKey(entry) {
  const e = normalizeAttrMpLinkEntry(entry);
  if (!e) return '';
  if (e.id) return `id:${e.id}`;
  if (e.name) return `name:${normalizeAttrCompareName(e.name)}`;
  return '';
}

export function normalizeAttrMpLinkList(raw) {
  if (raw == null || raw === '' || raw === false) return [];
  if (raw === true) return [{ id: '', name: 'Основное' }];
  const items = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const e = normalizeAttrMpLinkEntry(item);
    if (!e) continue;
    const k = attrMpLinkKey(e);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export function normalizeAttrMpLinks(raw) {
  const out = emptyAttrMpLinks();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const mp of ATTR_MP_CODES) {
    out[mp] = normalizeAttrMpLinkList(raw[mp]);
  }
  return out;
}

export function attrMpLinksHasAny(raw) {
  const links = normalizeAttrMpLinks(raw);
  return ATTR_MP_CODES.some((mp) => links[mp].length > 0);
}

export function mappedMpsFromAttrLinks(raw) {
  const links = normalizeAttrMpLinks(raw);
  return ATTR_MP_CODES.filter((mp) => links[mp].length > 0);
}

export function formatAttrMpLinksSummary(raw) {
  const links = normalizeAttrMpLinks(raw);
  const parts = [];
  const fmt = (list) => list.map((e) => e.name || e.id).filter(Boolean).join(', ');
  if (links.ozon.length) parts.push(`OZ: ${fmt(links.ozon)}`);
  if (links.wb.length) parts.push(`WB: ${fmt(links.wb)}`);
  if (links.ym.length) parts.push(`ЯМ: ${fmt(links.ym)}`);
  return parts.length ? parts.join(' · ') : 'не связано';
}

export function addAttrMpLink(links, mp, entry) {
  const current = normalizeAttrMpLinks(links);
  const code = String(mp || '').toLowerCase();
  if (!ATTR_MP_CODES.includes(code)) return current;
  const nextEntry = normalizeAttrMpLinkEntry(entry);
  if (!nextEntry) return current;
  const list = normalizeAttrMpLinkList([...(current[code] || []), nextEntry]);
  return { ...current, [code]: list };
}

export function removeAttrMpLink(links, mp, entry) {
  const current = normalizeAttrMpLinks(links);
  const code = String(mp || '').toLowerCase();
  if (!ATTR_MP_CODES.includes(code)) return current;
  const drop = attrMpLinkKey(entry);
  if (!drop) return current;
  return {
    ...current,
    [code]: (current[code] || []).filter((e) => attrMpLinkKey(e) !== drop),
  };
}

function matchMpAttribute(entry, attributes, getId, getName) {
  const e = normalizeAttrMpLinkEntry(entry);
  if (!e) return null;
  const list = Array.isArray(attributes) ? attributes : [];
  const idOf = typeof getId === 'function' ? getId : (a) => a?.id;
  const nameOf = typeof getName === 'function' ? getName : (a) => a?.name;
  if (e.id) {
    const hit = list.find((a) => String(idOf(a) ?? '') === String(e.id));
    if (hit) return hit;
  }
  if (e.name) {
    const want = normalizeAttrCompareName(e.name);
    if (!want) return null;
    return list.find((a) => normalizeAttrCompareName(nameOf(a)) === want) || null;
  }
  return null;
}

export function findLinkedMpAttributes(link, attributes, getId, getName) {
  const entries = normalizeAttrMpLinkList(link);
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const hit = matchMpAttribute(entry, attributes, getId, getName);
    if (!hit) continue;
    const idOf = typeof getId === 'function' ? getId : (a) => a?.id;
    const k = String(idOf(hit) ?? '') || attrMpLinkKey(entry);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(hit);
  }
  return out;
}

export function findLinkedMpAttribute(link, attributes, getId, getName) {
  return findLinkedMpAttributes(link, attributes, getId, getName)[0] || null;
}

export function mpAttributeOptionValue(attr, getId, getName) {
  const id = String((typeof getId === 'function' ? getId(attr) : attr?.id) ?? '').trim();
  const name = String((typeof getName === 'function' ? getName(attr) : attr?.name) ?? '').trim();
  return JSON.stringify({ id, name });
}

export function parseMpAttributeOptionValue(raw) {
  if (!raw) return null;
  try {
    return normalizeAttrMpLinkEntry(JSON.parse(raw));
  } catch {
    return normalizeAttrMpLinkEntry(raw);
  }
}

const MP_SHORT = { ozon: 'OZ', wb: 'WB', ym: 'ЯМ' };
const MP_TITLE = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };

function displayMpAttrValue(raw, attr, resolveDisplay) {
  if (typeof resolveDisplay === 'function') return resolveDisplay(attr, raw) || '';
  if (raw == null) return '';
  return String(raw).trim();
}

/**
 * Расхождения ERP-атрибута с явно связанными характеристиками МП.
 */
export function getLinkedAttrMpDiffs(attr, mainValue, ctx = {}) {
  const links = normalizeAttrMpLinks(attr?.mp_links);
  const out = [];
  for (const ozonHit of findLinkedMpAttributes(links.ozon, ctx.ozonAttributes)) {
    if (ozonHit?.id == null) continue;
    const raw = ctx.ozonAttributeValues?.[String(ozonHit.id)];
    const text = displayMpAttrValue(raw, ozonHit, ctx.resolveOzonDisplay);
    if (attrValuesDiffer(mainValue, text)) {
      out.push({
        mp: 'ozon',
        label: MP_SHORT.ozon,
        title: `${MP_TITLE.ozon}: «${text}»`,
        value: text,
      });
    }
  }
  for (const wbHit of findLinkedMpAttributes(links.wb, ctx.wbAttributes, ctx.wbAttrKey, ctx.wbAttrName)) {
    const key = ctx.wbAttrKey ? ctx.wbAttrKey(wbHit) : String(wbHit.id ?? '');
    const raw = ctx.wbAttributeValues?.[key];
    const text = raw == null ? '' : String(raw);
    if (attrValuesDiffer(mainValue, text)) {
      out.push({
        mp: 'wb',
        label: MP_SHORT.wb,
        title: `${MP_TITLE.wb}: «${text}»`,
        value: text,
      });
    }
  }
  for (const entry of links.ym || []) {
    const id = String(entry?.id || '');
    if (!isYmOfferFieldAttrId(id)) continue;
    const text = id === '__ym_name__'
      ? String(ctx.mpYmName ?? '')
      : String(ctx.mpYmDescription ?? '');
    if (attrValuesDiffer(mainValue, text)) {
      out.push({
        mp: 'ym',
        label: MP_SHORT.ym,
        title: `${MP_TITLE.ym}: «${text}»`,
        value: text,
      });
    }
  }
  for (const ymHit of findLinkedMpAttributes(links.ym, ctx.ymAttributes)) {
    if (ymHit?.id == null || isYmOfferFieldAttrId(ymHit.id)) continue;
    const raw = ctx.ymAttributeValues?.[String(ymHit.id)];
    const text = displayMpAttrValue(raw, ymHit, ctx.resolveYmDisplay);
    if (attrValuesDiffer(mainValue, text)) {
      out.push({
        mp: 'ym',
        label: MP_SHORT.ym,
        title: `${MP_TITLE.ym}: «${text}»`,
        value: text,
      });
    }
  }
  return out;
}
