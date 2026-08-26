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
