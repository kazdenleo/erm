/**
 * Связь ERP-атрибута с характеристиками Ozon / WB / Яндекс.Маркета.
 * mp_links: { ozon?: { id, name }, wb?: { id, name }, ym?: { id, name } }
 */

import { attrValuesDiffer, normalizeAttrCompareName } from './productAttrMpDiff.js';

export const ATTR_MP_CODES = ['ozon', 'wb', 'ym'];

export function emptyAttrMpLinks() {
  return { ozon: null, wb: null, ym: null };
}

export function normalizeAttrMpLinkEntry(raw) {
  if (raw == null || raw === '') return null;
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

export function normalizeAttrMpLinks(raw) {
  const out = emptyAttrMpLinks();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const mp of ATTR_MP_CODES) {
    out[mp] = normalizeAttrMpLinkEntry(raw[mp]);
  }
  return out;
}

export function attrMpLinksHasAny(raw) {
  const links = normalizeAttrMpLinks(raw);
  return ATTR_MP_CODES.some((mp) => links[mp]);
}

export function mappedMpsFromAttrLinks(raw) {
  const links = normalizeAttrMpLinks(raw);
  return ATTR_MP_CODES.filter((mp) => links[mp]);
}

export function formatAttrMpLinksSummary(raw) {
  const links = normalizeAttrMpLinks(raw);
  const parts = [];
  if (links.ozon) parts.push(`OZ: ${links.ozon.name || links.ozon.id}`);
  if (links.wb) parts.push(`WB: ${links.wb.name || links.wb.id}`);
  if (links.ym) parts.push(`ЯМ: ${links.ym.name || links.ym.id}`);
  return parts.length ? parts.join(' · ') : 'не связано';
}

export function attrMpLinkKey(entry) {
  if (!entry) return '';
  if (entry.id) return `id:${entry.id}`;
  if (entry.name) return `name:${normalizeAttrCompareName(entry.name)}`;
  return '';
}

export function findLinkedMpAttribute(link, attributes, getId, getName) {
  const entry = normalizeAttrMpLinkEntry(link);
  if (!entry) return null;
  const list = Array.isArray(attributes) ? attributes : [];
  const idOf = typeof getId === 'function' ? getId : (a) => a?.id;
  const nameOf = typeof getName === 'function' ? getName : (a) => a?.name;
  if (entry.id) {
    const hit = list.find((a) => String(idOf(a) ?? '') === String(entry.id));
    if (hit) return hit;
  }
  if (entry.name) {
    const want = normalizeAttrCompareName(entry.name);
    if (!want) return null;
    return list.find((a) => normalizeAttrCompareName(nameOf(a)) === want) || null;
  }
  return null;
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
  const ozonHit = findLinkedMpAttribute(links.ozon, ctx.ozonAttributes);
  if (ozonHit?.id != null) {
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
  const wbHit = findLinkedMpAttribute(links.wb, ctx.wbAttributes, ctx.wbAttrKey, ctx.wbAttrName);
  if (wbHit) {
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
  const ymHit = findLinkedMpAttribute(links.ym, ctx.ymAttributes);
  if (ymHit?.id != null) {
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
