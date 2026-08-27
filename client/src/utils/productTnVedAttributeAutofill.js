/**
 * Автоподстановка кода ТН ВЭД в атрибуты карточки МП.
 */

function normalizeAttrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEmptyMarketplaceValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => isEmptyMarketplaceValue(x));
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

export function isTnVedAttributeName(name) {
  const n = normalizeAttrName(name);
  if (!n) return false;
  const compact = n.replace(/\s+/g, '');
  return (
    /тн\s*вэд/.test(n) ||
    compact.includes('тнвэд') ||
    /tn\s*ved/.test(n) ||
    compact.includes('tnved') ||
    /код\s*тн/.test(n) ||
    /commodity\s*code/.test(n) ||
    /feacn/.test(n) ||
    /hs\s*code/.test(n)
  );
}

export function leadingTnVedDigits(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\d{6,14})/);
  return m ? m[1] : '';
}

export function matchOzonTnVedDictEntry(entries, code) {
  const digits = String(code || '').replace(/\D/g, '');
  if (!digits || !Array.isArray(entries) || entries.length === 0) return null;
  const hits = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const text = String(entry.value ?? entry.name ?? entry.info ?? '').trim();
    const lead = leadingTnVedDigits(text);
    const compact = text.replace(/\D/g, '');
    const startsWithCode =
      text.startsWith(digits) && (text.length === digits.length || !/\d/.test(text.charAt(digits.length)));
    if (lead === digits || compact === digits || startsWithCode) hits.push(entry);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.value ?? b.name ?? '').length - String(a.value ?? a.name ?? '').length);
  return hits[0];
}

/** 10-значный ТН ВЭД из сохранённого Ozon-значения; иначе код категории. */
export function ozonStoredTnVedSearchCode(raw, categoryCode) {
  const fallback = String(categoryCode || '').replace(/\D/g, '');
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const did = Number(raw.dictionary_value_id ?? raw.id);
    const didStr = Number.isFinite(did) && did > 0 ? String(did) : '';
    if (didStr && didStr.length !== 10) return '';
    const text = String(raw.value ?? '').trim();
    const fromText = leadingTnVedDigits(text) || text.replace(/\D/g, '');
    if (fromText.length === 10) return fromText;
    if (didStr.length === 10) return didStr;
    return fallback;
  }
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!s) return fallback;
  if (/^\d{10}$/.test(s)) return s;
  const lead = leadingTnVedDigits(s);
  if (lead.length === 10) return lead;
  const compact = s.replace(/\D/g, '');
  if (compact.length === 10) return compact;
  return '';
}

export function categoryTnVedDigits(product, categories = []) {
  const list = Array.isArray(categories) ? categories : [];
  const byId = new Map(list.map((c) => [String(c.id), c]));
  const cid = String(product?.user_category_id ?? product?.categoryId ?? '').trim();
  const seen = new Set();
  let cat = cid ? byId.get(cid) : null;
  while (cat && !seen.has(String(cat.id))) {
    seen.add(String(cat.id));
    const digits = String(cat.tn_ved_code || cat.tnVedCode || '').replace(/\D/g, '');
    if (digits) return digits;
    const parentId = cat.parent_id ?? cat.parentId;
    cat = parentId != null && String(parentId).trim() !== '' ? byId.get(String(parentId)) : null;
  }
  const raw =
    product?.category_tn_ved_code ||
    product?.tn_ved_code ||
    product?.tnVedCode ||
    '';
  return String(raw || '').replace(/\D/g, '');
}

/**
 * @param {Array} attributes
 * @param {string} tnVedCode
 * @param {object} prevValues
 * @param {{ getAttrKey: Function, getAttrName: Function, resolveEnumValue?: Function }} opts
 */
export function applyTnVedAutofillToAttributes(attributes, tnVedCode, prevValues, opts) {
  const code = String(tnVedCode || '').replace(/\D/g, '');
  if (!code || !Array.isArray(attributes) || attributes.length === 0) return prevValues;

  const getAttrKey = opts.getAttrKey;
  const getAttrName = opts.getAttrName;
  const resolveEnumValue = opts.resolveEnumValue;

  let changed = false;
  const next = { ...prevValues };

  for (const attr of attributes) {
    const key = getAttrKey(attr);
    if (!key || !isEmptyMarketplaceValue(next[key])) continue;
    if (!isTnVedAttributeName(getAttrName(attr))) continue;

    const resolved = resolveEnumValue ? resolveEnumValue(attr, code, { kind: 'tn_ved' }) : code;
    if (!isEmptyMarketplaceValue(resolved)) {
      next[key] = resolved;
      changed = true;
    }
  }

  return changed ? next : prevValues;
}

/**
 * Привязки ТН ВЭД бренда для категории товара.
 */
export function filterTnVedBindingsForCategory(bindings, categoryId) {
  const list = Array.isArray(bindings) ? bindings : [];
  const cid = categoryId != null ? String(categoryId).trim() : '';
  if (!cid) return [];
  return list.filter((b) => {
    const ids = b.user_category_ids ?? b.userCategoryIds ?? [];
    if (!Array.isArray(ids) || ids.length === 0) return false;
    return ids.some((id) => String(id) === cid);
  });
}
