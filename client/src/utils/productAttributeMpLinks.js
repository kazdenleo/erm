/**
 * Связь ERP-атрибута с характеристиками Ozon / WB / Яндекс.Маркета.
 * mp_links: { ozon?: [{ id, name }, ...], wb?: [...], ym?: [...] }
 * Старый формат { ozon: { id, name } } читается как массив из одного элемента.
 */

import { attrValuesDiffer, normalizeAttrCompareName, attrLinkNamesMatch } from './productAttrMpDiff.js';
import {
  isMpOfferFieldAttrId,
  readMpOfferFieldValue,
  resolveMpOfferFieldIdByName,
} from './productMpFieldLinks.js';

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

export const MP_CATEGORY_LINK_ICON_TITLE = 'Связано с основным атрибутом в настройках категории';

/** ERP-атрибут категории, сопоставленный с полем/характеристикой МП. */
export function findErpAttrLinkedToMpTarget(categoryAttributes, mp, target, labelMaps = {}) {
  const code = String(mp || '').toLowerCase();
  if (!ATTR_MP_CODES.includes(code) || !target || typeof target !== 'object') return null;
  const wantAttrId = target.kind === 'attr' ? String(target.attrId ?? '') : '';
  const wantOfferId = target.kind === 'offer' ? String(target.offerId ?? '') : '';
  const wantAttrName = target.kind === 'attr' ? normalizeAttrCompareName(target.attrName) : '';
  for (const erp of categoryAttributes || []) {
    const links = normalizeAttrMpLinks(erp?.mp_links);
    for (const entry of links[code] || []) {
      const e = normalizeAttrMpLinkEntry(entry);
      if (!e) continue;
      if (target.kind === 'attr' && wantAttrId && e.id && !isMpOfferFieldAttrId(e.id)) {
        if (String(e.id) === wantAttrId) return erp;
      }
      if (target.kind === 'offer' && wantOfferId && e.id) {
        if (String(e.id) === wantOfferId) return erp;
      }
      if (target.kind === 'attr' && wantAttrName && e.name) {
        if (attrLinkNamesMatch(e.name, target.attrName)) return erp;
      }
      let resolved;
      try {
        resolved = resolveAttrMpLinkTarget(entry, code, labelMaps);
      } catch {
        resolved = null;
      }
      if (!resolved) continue;
      if (
        target.kind === 'attr' &&
        resolved.kind === 'attr' &&
        wantAttrId &&
        String(resolved.attrId) === wantAttrId
      ) {
        return erp;
      }
      if (
        target.kind === 'offer' &&
        resolved.kind === 'offer' &&
        wantOfferId &&
        String(resolved.offerId) === wantOfferId
      ) {
        return erp;
      }
    }
  }
  return null;
}

export function isMpSchemaAttrLinkedInCategory(
  categoryAttributes,
  mp,
  attrId,
  labelMaps = {},
  attrName = ''
) {
  return !!findErpAttrLinkedToMpTarget(
    categoryAttributes,
    mp,
    { kind: 'attr', attrId: String(attrId ?? ''), attrName: String(attrName || '') },
    labelMaps
  );
}

export function isMpOfferFieldLinkedInCategory(categoryAttributes, mp, offerId, labelMaps = {}) {
  return !!findErpAttrLinkedToMpTarget(
    categoryAttributes,
    mp,
    { kind: 'offer', offerId: String(offerId ?? '') },
    labelMaps
  );
}

/** Есть ли в attribute_mp_links категорий сопоставление с полем/характеристикой МП. */
export function isMpTargetLinkedInCategoryCategories(
  categories,
  categoryIds,
  mp,
  target,
  labelMaps = {}
) {
  const ids =
    categoryIds instanceof Set
      ? categoryIds
      : new Set((Array.isArray(categoryIds) ? categoryIds : []).map((id) => String(id)));
  for (const cat of categories || []) {
    const cid = String(cat?.id ?? '');
    if (ids.size && !ids.has(cid)) continue;
    const am = cat?.attribute_mp_links;
    if (!am || typeof am !== 'object' || Array.isArray(am)) continue;
    for (const raw of Object.values(am)) {
      const pseudo = [{ mp_links: normalizeAttrMpLinks(raw) }];
      if (findErpAttrLinkedToMpTarget(pseudo, mp, target, labelMaps)) return true;
    }
  }
  return false;
}

export function dedicatedCharcLinksForMainField(dedicatedLinks, fieldKey) {
  const key = String(fieldKey || '').trim();
  if (!key || !dedicatedLinks || typeof dedicatedLinks !== 'object') return null;
  if (dedicatedLinks[key]) return dedicatedLinks[key];
  if (key === 'country' && dedicatedLinks.country_of_origin) return dedicatedLinks.country_of_origin;
  if (key === 'country_of_origin' && dedicatedLinks.country) return dedicatedLinks.country;
  return null;
}

export function mappedMpsFromDedicatedMainField(dedicatedLinks, fieldKey) {
  return mappedMpsFromAttrLinks(dedicatedCharcLinksForMainField(dedicatedLinks, fieldKey));
}

function mpSchemaAttrName(meta) {
  if (!meta || typeof meta !== 'object') return '';
  return String(meta.name || meta.title || meta.label || '').trim();
}

/**
 * Цель сопоставления ERP-атрибута с полем МП: поле оффера (__ym_shop_sku__) или param id категории.
 * Поддерживает записи только с name (ручной ввод в категории).
 */
export function resolveAttrMpLinkTarget(entry, mp, labelMaps = {}) {
  const e = normalizeAttrMpLinkEntry(entry);
  if (!e) return null;
  const code = String(mp || '').toLowerCase();
  if (!ATTR_MP_CODES.includes(code)) return null;

  if (e.id && isMpOfferFieldAttrId(e.id)) {
    return { kind: 'offer', offerId: String(e.id) };
  }

  if (e.id) {
    return { kind: 'attr', attrId: String(e.id) };
  }

  const offerId = resolveMpOfferFieldIdByName(code, e.name);
  if (offerId) return { kind: 'offer', offerId };

  const want = normalizeAttrCompareName(e.name);
  if (want) {
    const maps = labelMaps?.[code] || {};
    for (const [attrId, meta] of Object.entries(maps)) {
      const label = mpSchemaAttrName(meta);
      if (label && attrLinkNamesMatch(e.name, label)) {
        return { kind: 'attr', attrId: String(attrId) };
      }
    }
  }

  return null;
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
  const formLike = ctx.formData || ctx;
  for (const mp of ATTR_MP_CODES) {
    for (const entry of links[mp] || []) {
      const target = resolveAttrMpLinkTarget(entry, mp, ctx.labelMaps || {});
      if (target?.kind !== 'offer') continue;
      const text = readMpOfferFieldValue(formLike, target.offerId);
      if (attrValuesDiffer(mainValue, text)) {
        out.push({
          mp,
          label: MP_SHORT[mp],
          title: `${MP_TITLE[mp]}: «${text}»`,
          value: text,
        });
      }
    }
  }
  for (const ozonHit of findLinkedMpAttributes(links.ozon, ctx.ozonAttributes)) {
    if (ozonHit?.id == null || isMpOfferFieldAttrId(ozonHit.id)) continue;
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
    if (isMpOfferFieldAttrId(wbHit?.id ?? wbHit?.charcID)) continue;
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
  for (const ymHit of findLinkedMpAttributes(links.ym, ctx.ymAttributes)) {
    if (ymHit?.id == null || isMpOfferFieldAttrId(ymHit.id)) continue;
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
