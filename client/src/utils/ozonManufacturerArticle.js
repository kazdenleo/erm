/** Ozon: артикул производителя (партномер), не offer_id продавца и не отдельное поле OEM. */

export const OZON_PARTNUMBER_ATTR_ID = 7236;
export const OZON_SELLER_CODE_ATTR_ID = 9024;
export const OZON_ALTERNATIVE_ARTICLES_ATTR_ID = 11031;

function normalizeOzonAttrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const OEM_TOKEN_RE = /[oо][eе][mм]/i;

/** Отдельная характеристика/атрибут OEM — не то же самое, что Ozon 7236. */
export function isStandaloneOemAttrName(name) {
  const n = normalizeOzonAttrName(name);
  if (!n) return false;
  if (n.includes('артикул производител') || n.includes('партномер') || n.includes('part number')) {
    return false;
  }
  return OEM_TOKEN_RE.test(n);
}

export function isOzonManufacturerArticleAttr(attr) {
  if (!attr) return false;
  const id = Number(attr.id ?? attr.attribute_id);
  if (id === OZON_PARTNUMBER_ATTR_ID) return true;
  const n = normalizeOzonAttrName(attr.name);
  if (!n) return false;
  if (isStandaloneOemAttrName(n)) return false;
  if (n.includes('артикул продавца') || n.includes('offer id') || n.includes('offer_id')) return false;
  if (n.includes('артикул производител') || n.includes('код производител')) return true;
  if (n.includes('партномер') || n.includes('partnumber') || n.includes('part number')) return true;
  if (n === 'mpn' || n.includes('manufacturer part')) return true;
  return false;
}

/** Ozon «Код продавца» (id 9024) — зеркало артикула ERP при связи sku. */
export function isOzonSellerCodeAttr(attr) {
  if (!attr) return false;
  if (Number(attr.id ?? attr.attribute_id) === OZON_SELLER_CODE_ATTR_ID) return true;
  const n = normalizeOzonAttrName(attr.name);
  return n.includes('код продавца');
}

export function findOzonManufacturerArticleAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonManufacturerArticleAttr);
}

/** OEM / артикул производителя — свободный текст, не справочник Ozon. */
export function isOzonFreeTextMpAttr(attr) {
  if (!attr) return false;
  if (isOzonManufacturerArticleAttr(attr)) return true;
  return isStandaloneOemAttrName(attr.name ?? attr.attribute_name);
}

/** Списки артикулов (аналоги / OEM / альтернативные) — в Ozon через «; ». */
export function isOzonArticleListAttr(attr) {
  if (!attr) return false;
  const id = Number(attr.id ?? attr.attribute_id);
  if (id === OZON_ALTERNATIVE_ARTICLES_ATTR_ID) return true;
  if (isOzonFreeTextMpAttr(attr)) return true;
  const n = normalizeOzonAttrName(attr.name ?? attr.attribute_name ?? attr.label);
  if (!n) return false;
  if (n.includes('альтернативн') && n.includes('артикул')) return true;
  if (/(^|\s)аналог/.test(n) && !n.includes('применимост')) return true;
  return false;
}

export function isErpAnalogLikeAttrName(name) {
  const n = normalizeOzonAttrName(name);
  if (!n) return false;
  return /аналог/.test(n) && !n.includes('применимост');
}

export function formatOzonArticleListText(text) {
  const parts = String(text || '')
    .split(/[;,\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.join('; ');
}

function ozonCardValuePart(v) {
  if (v == null) return '';
  const textRaw =
    v.value != null && String(v.value).trim() !== '' ? String(v.value).trim() : '';
  const dictId =
    v.dictionary_value_id != null && String(v.dictionary_value_id).trim() !== ''
      ? String(v.dictionary_value_id).trim()
      : v.id != null && String(v.id).trim() !== ''
        ? String(v.id).trim()
        : '';
  const text =
    textRaw && !(dictId && textRaw === dictId && /^\d+$/.test(textRaw)) ? textRaw : '';
  if (text) {
    const arrow = text.indexOf('->');
    return arrow > 0 ? text.slice(0, arrow).trim() : text;
  }
  return dictId;
}

/** Все значения коллекции Ozon для поля формы (OEM и т.п.), через «; ». */
export function ozonCardAttrToFormText(a, opts = {}) {
  if (!a) return '';
  const preferText = opts.preferText === true;
  if (Array.isArray(a.values) && a.values.length) {
    const joinAll = a.values.length > 1 || isOzonFreeTextMpAttr(a);
    if (joinAll) {
      const parts = a.values.map(ozonCardValuePart).map((s) => String(s || '').trim()).filter(Boolean);
      if (parts.length) return parts.join('; ');
    }
    const v0 = a.values[0];
    if (v0 != null) {
      const dictId =
        v0.dictionary_value_id != null && String(v0.dictionary_value_id).trim() !== ''
          ? String(v0.dictionary_value_id).trim()
          : v0.id != null && String(v0.id).trim() !== ''
            ? String(v0.id).trim()
            : '';
      const text = ozonCardValuePart(v0);
      if (preferText) return text || dictId;
      return dictId || text;
    }
  }
  if (a.value != null && typeof a.value === 'object') {
    return String(a.value.value ?? a.value.text ?? a.value.id ?? '').trim();
  }
  return a.value != null ? String(a.value).trim() : '';
}

export function looksLikeOzonPartNumber(text) {
  const s = String(text || '').trim();
  if (s.length < 2 || s.length > 80) return false;
  if (/\s/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  return /^[0-9A-Za-z._\-\\/]+$/.test(s);
}

/**
 * @returns {{ text: string, dictId: number|null }}
 */
export function parseOzonStoredAttr(raw) {
  if (raw == null || raw === '') return { text: '', dictId: null };
  if (Array.isArray(raw)) {
    const parts = raw
      .map((x) => {
        if (x && typeof x === 'object') return String(x.value ?? x.dictionary_value_id ?? '').trim();
        return String(x ?? '').trim();
      })
      .filter(Boolean);
    return { text: parts.join('; '), dictId: null };
  }
  if (typeof raw === 'object') {
    const text = String(raw.value ?? '').trim();
    const didRaw = raw.dictionary_value_id ?? (text ? null : raw.id);
    const didNum = didRaw != null && String(didRaw).trim() !== '' ? Number(didRaw) : NaN;
    const dictId = Number.isFinite(didNum) && didNum > 0 ? didNum : null;
    return { text, dictId };
  }
  const s = String(raw).trim();
  const arrow = s.indexOf('->');
  if (arrow > 0) {
    const text = s.slice(0, arrow).trim();
    const idPart = s.slice(arrow + 2).trim();
    const did = Number(idPart);
    const dictId = /^\d+$/.test(idPart) && Number.isFinite(did) && did > 0 ? did : null;
    return { text, dictId };
  }
  return { text: s, dictId: null };
}

const OZON_ANNOTATION_ATTR_ID = 4191;
const OZON_OEM_ATTR_ID = 7324;

function schemaIsCollection(attr) {
  if (!attr || typeof attr !== 'object') return false;
  return attr.is_collection === true || attr.isCollection === true;
}

function schemaDictionaryId(attr) {
  if (!attr || typeof attr !== 'object') return 0;
  for (const k of ['dictionary_id', 'attribute_dictionary_id', 'dictionaryId', 'dictionaryID']) {
    const n = Number(attr[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function schemaHasOzonDictionary(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (Number(attr.id ?? attr.attribute_id) === 85) return true;
  return schemaDictionaryId(attr) > 0;
}

function schemaIsPlainStringAttr(attr) {
  if (!attr || typeof attr !== 'object') return false;
  const t = String(attr.type ?? attr.attribute_type ?? '').toLowerCase();
  const plain = t === 'string' || t === 'multiline' || t === 'text';
  return plain && schemaDictionaryId(attr) === 0 && Number(attr.id ?? attr.attribute_id) !== 85;
}

/**
 * Значения атрибута для /v3/product/import.
 * OEM и партномер всегда уходят как { value }, иначе Ozon пишет «словарное значение» и поле пустое.
 */
function joinOzonOemList(text) {
  return formatOzonArticleListText(text);
}

function joinOzonListAsSentence(text) {
  return String(text || '')
    .split(/[;,\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join('. ');
}

function sanitizeOzonSingletonText(id, text, attrMeta) {
  let s = String(text || '').trim();
  if (!s) return s;
  const attrId = Number(id);
  if (schemaIsCollection(attrMeta) && attrId !== OZON_ANNOTATION_ATTR_ID) {
    return joinOzonOemList(s) || s;
  }
  if (attrId === OZON_ANNOTATION_ATTR_ID) {
    return s
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s*;\s*/g, '. ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const articleList = isOzonArticleListAttr(attrMeta || { id: attrId, name: '' });
  const oem =
    attrId === OZON_OEM_ATTR_ID ||
    attrId === OZON_PARTNUMBER_ATTR_ID ||
    attrId === OZON_ALTERNATIVE_ARTICLES_ATTR_ID ||
    articleList ||
    isOzonFreeTextMpAttr(attrMeta || { id: attrId, name: '' });
  if (oem) return joinOzonOemList(s);
  return joinOzonListAsSentence(s);
}

export function ozonBooleanAttrValue(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');
  if (!s) return 'false';
  if (/^(1|true|да|yes)$/.test(s)) return 'true';
  return 'false';
}

export function ozonAttrValuesForApi(id, raw, attrMeta) {
  const { text, dictId } = parseOzonStoredAttr(raw);
  const meta = attrMeta && typeof attrMeta === 'object' ? { ...attrMeta, id: attrMeta.id ?? id } : { id };
  const type = String(meta.type ?? meta.attribute_type ?? '').toLowerCase();
  if (type === 'boolean') {
    return [{ value: ozonBooleanAttrValue(text || (dictId != null ? String(dictId) : '')) }];
  }
  const isFreeText =
    Number(id) === OZON_PARTNUMBER_ATTR_ID || isOzonFreeTextMpAttr(meta);
  const forcePlain =
    isFreeText ||
    schemaIsPlainStringAttr(meta) ||
    (looksLikeOzonPartNumber(text) && !schemaHasOzonDictionary(meta));
  if (forcePlain) {
    const v = sanitizeOzonSingletonText(id, text || (dictId != null ? String(dictId) : ''), meta);
    if (!v) return null;
    return [{ value: v }];
  }
  if (dictId != null) return [{ dictionary_value_id: dictId }];
  if (text) return [{ value: sanitizeOzonSingletonText(id, text, meta) }];
  return null;
}

/**
 * Ozon: String/аннотация/OEM часто не коллекция. Несколько {value} → одно значение.
 * @param {Array<{ id?: number, values?: object[] }>} attrs
 * @returns {typeof attrs}
 */
export function collapseOzonNonCollectionAttrValues(attrs) {
  const list = Array.isArray(attrs) ? attrs : [];
  const byId = new Map();
  for (const a of list) {
    const id = Number(a?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    byId.set(id, a);
  }
  return [...byId.values()].map((a) => {
    const id = Number(a.id);
    const vals = Array.isArray(a.values) ? a.values.filter((v) => v != null) : [];
    if (vals.length <= 1) {
      const v = vals[0];
      const did = v != null ? Number(v.dictionary_value_id) : 0;
      if (!v || (Number.isFinite(did) && did > 0)) return a;
      const next = sanitizeOzonSingletonText(id, v.value ?? '', a);
      if (!next || next === String(v.value ?? '').trim()) return a;
      return { ...a, values: [{ value: next }] };
    }
    const allDict = vals.every(
      (v) => v.dictionary_value_id != null && Number(v.dictionary_value_id) > 0
    );
    if (allDict) return a;
    const texts = vals.map((v) => String(v.value ?? '').trim()).filter(Boolean);
    if (!texts.length) return { ...a, values: [vals[0]] };
    const articleList =
      id === OZON_OEM_ATTR_ID ||
      id === OZON_PARTNUMBER_ATTR_ID ||
      id === OZON_ALTERNATIVE_ARTICLES_ATTR_ID ||
      isOzonArticleListAttr(a);
    if (articleList) {
      return {
        ...a,
        complex_id: a.complex_id ?? 0,
        values: [{ value: sanitizeOzonSingletonText(id, texts.join('; '), a) }],
      };
    }
    const joined = texts.join(id === OZON_ANNOTATION_ATTR_ID ? ' ' : '. ');
    return { ...a, complex_id: a.complex_id ?? 0, values: [{ value: sanitizeOzonSingletonText(id, joined, a) }] };
  });
}
