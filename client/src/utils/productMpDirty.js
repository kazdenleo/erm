/**
 * Трекинг изменённых полей карточки по маркетплейсам (подсветка + селективный пуш).
 */

export const MP_CARD_FIELD_KEYS = {
  ozon: ['mp_ozon_name', 'mp_ozon_description', 'mp_ozon_brand'],
  wb: ['mp_wb_vendor_code', 'mp_wb_name', 'mp_wb_description', 'mp_wb_brand'],
  ym: ['mp_ym_name', 'mp_ym_description'],
};

export const MP_LABELS = {
  ozon: 'Ozon',
  wb: 'Wildberries',
  ym: 'Яндекс.Маркет',
};

function normScalar(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normAttrMap(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [k, v] of Object.entries(map)) {
    const key = String(k).trim();
    if (!key) continue;
    if (v === undefined || v === null) continue;
    const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v).trim();
    if (s === '') continue;
    out[key] = s;
  }
  return out;
}

function attrMapsEqual(a, b) {
  const aa = normAttrMap(a);
  const bb = normAttrMap(b);
  const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
  for (const k of keys) {
    if ((aa[k] || '') !== (bb[k] || '')) return false;
  }
  return true;
}

/**
 * @param {{ fields?: Record<string, string>, ozonAttrs?: object, wbAttrs?: object, ymAttrs?: object }} parts
 */
export function buildMpBaseline(parts = {}) {
  const fields = {};
  for (const mp of Object.keys(MP_CARD_FIELD_KEYS)) {
    for (const key of MP_CARD_FIELD_KEYS[mp]) {
      fields[key] = normScalar(parts.fields?.[key]);
    }
  }
  return {
    fields,
    ozonAttrs: normAttrMap(parts.ozonAttrs),
    wbAttrs: normAttrMap(parts.wbAttrs),
    ymAttrs: normAttrMap(parts.ymAttrs),
  };
}

export function isMpFieldDirty(baseline, fieldKey, currentValue) {
  if (!baseline?.fields) return false;
  if (!Object.prototype.hasOwnProperty.call(baseline.fields, fieldKey)) return false;
  return baseline.fields[fieldKey] !== normScalar(currentValue);
}

export function isMpAttrDirty(baseline, marketplace, attrId, currentValue) {
  if (!baseline) return false;
  const key = String(attrId);
  const mapKey = marketplace === 'ozon' ? 'ozonAttrs' : marketplace === 'wb' ? 'wbAttrs' : 'ymAttrs';
  const baseMap = baseline[mapKey] || {};
  const cur = normScalar(currentValue);
  const base = baseMap[key] || '';
  // пустое текущее vs отсутствующее в baseline — не dirty
  if (cur === '' && base === '') return false;
  return cur !== base;
}

/**
 * @returns {Array<'ozon'|'wb'|'ym'>}
 */
export function getDirtyMarketplaces(baseline, formData, ozonAttrs, wbAttrs, ymAttrs) {
  if (!baseline) return [];
  const dirty = [];
  for (const mp of /** @type {const} */ (['ozon', 'wb', 'ym'])) {
    const fieldDirty = MP_CARD_FIELD_KEYS[mp].some((key) =>
      isMpFieldDirty(baseline, key, formData?.[key])
    );
    const attrs =
      mp === 'ozon' ? ozonAttrs : mp === 'wb' ? wbAttrs : ymAttrs;
    const baseAttrs =
      mp === 'ozon' ? baseline.ozonAttrs : mp === 'wb' ? baseline.wbAttrs : baseline.ymAttrs;
    const attrDirty = !attrMapsEqual(baseAttrs, attrs);
    if (fieldDirty || attrDirty) dirty.push(mp);
  }
  return dirty;
}

export function formatDirtyMpList(mps) {
  return (mps || []).map((m) => MP_LABELS[m] || m).join(', ');
}
