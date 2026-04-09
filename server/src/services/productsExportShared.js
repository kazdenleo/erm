/**
 * Общие функции разбора атрибутов для экспорта Excel (товары + справочники).
 */

export function parseJsonb(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v !== null) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  return null;
}

export function formatScalar(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(formatScalar).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    return (
      v.value ??
      v.dictionary_value_name ??
      v.name ??
      v.text ??
      (() => {
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      })()
    );
  }
  return String(v);
}

export function extractOzonAttributesFromDraft(d) {
  const draft = parseJsonb(d);
  if (!draft || typeof draft !== 'object') return null;
  const candidates = [
    draft.attributes,
    draft.items?.[0]?.attributes,
    draft.result?.items?.[0]?.attributes,
    draft.result?.attributes,
    Array.isArray(draft.result) ? draft.result[0]?.attributes : null,
    draft.attribute_values
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c;
  }
  return null;
}

export function extractWbFromDraft(d) {
  const draft = parseJsonb(d);
  if (!draft || typeof draft !== 'object') return null;
  if (Array.isArray(draft.characteristics) && draft.characteristics.length) return draft.characteristics;
  if (Array.isArray(draft.data?.characteristics) && draft.data.characteristics.length) return draft.data.characteristics;
  if (Array.isArray(draft.nomenclatures?.[0]?.characteristics) && draft.nomenclatures[0].characteristics.length) {
    return draft.nomenclatures[0].characteristics;
  }
  return null;
}

export function extractYmFromDraft(d) {
  const draft = parseJsonb(d);
  if (!draft || typeof draft !== 'object') return null;
  if (Array.isArray(draft.parameters) && draft.parameters.length) return draft.parameters;
  if (Array.isArray(draft.parameterValues) && draft.parameterValues.length) return draft.parameterValues;
  if (Array.isArray(draft.offer?.parameterValues) && draft.offer.parameterValues.length) return draft.offer.parameterValues;
  if (draft.mapping?.parameters && typeof draft.mapping.parameters === 'object') return draft.mapping.parameters;
  return null;
}

export function isNonEmptyAttrsMap(o) {
  return Boolean(o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0);
}

export function getMergedOzonRaw(p) {
  const direct = parseJsonb(p.ozon_attributes);
  if (isNonEmptyAttrsMap(direct) || (Array.isArray(direct) && direct.length > 0)) return direct;
  return extractOzonAttributesFromDraft(p.ozon_draft);
}

export function getMergedWbRaw(p) {
  const direct = parseJsonb(p.wb_attributes);
  if (isNonEmptyAttrsMap(direct) || (Array.isArray(direct) && direct.length > 0)) return direct;
  return extractWbFromDraft(p.wb_draft);
}

export function getMergedYmRaw(p) {
  const direct = parseJsonb(p.ym_attributes);
  if (isNonEmptyAttrsMap(direct) || (Array.isArray(direct) && direct.length > 0)) return direct;
  return extractYmFromDraft(p.ym_draft);
}

export function extractOzonValue(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    return formatScalar(v.value ?? v.dictionary_value_name ?? v);
  }
  return String(v);
}

export function normalizeOzonToRows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const id = item.id ?? item.attribute_id ?? '';
        const name = item.name ?? item.attribute_name ?? item.title ?? (id !== '' && id != null ? `Атрибут ${id}` : '');
        let value = '';
        if (Array.isArray(item.values) && item.values.length > 0) {
          value = item.values.map((x) => extractOzonValue(x)).filter(Boolean).join(', ');
        } else if (item.value !== undefined && item.value !== null) {
          value = formatScalar(item.value);
        }
        return {
          attribute_id: id !== '' && id != null ? String(id) : '',
          attribute_name: name ? String(name) : String(id),
          value
        };
      })
      .filter(Boolean);
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw).map(([k, v]) => ({
      attribute_id: k,
      attribute_name: k,
      value: formatScalar(v)
    }));
  }
  return [];
}

export function normalizeWbToRows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((c) => {
        if (!c || typeof c !== 'object') return null;
        const id = c.id ?? c.characteristic_id ?? c.charcID ?? '';
        const name = c.name ?? c.charcName ?? (id !== '' && id != null ? `Характеристика ${id}` : '');
        const val = Array.isArray(c.value) ? c.value.map((x) => formatScalar(x)).join(', ') : formatScalar(c.value);
        return {
          attribute_id: id !== '' && id != null ? String(id) : '',
          attribute_name: name ? String(name) : String(id),
          value: val
        };
      })
      .filter(Boolean);
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw).map(([k, v]) => ({
      attribute_id: k,
      attribute_name: k,
      value: formatScalar(v)
    }));
  }
  return [];
}

export function normalizeYmToRows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((x) => {
        if (x == null) return null;
        if (typeof x !== 'object') {
          return { attribute_id: '', attribute_name: '', value: formatScalar(x) };
        }
        const id = x.id ?? x.parameterId ?? '';
        const name = x.name ?? x.parameterName ?? x.title ?? (id ? String(id) : '');
        const value = formatScalar(x.value ?? x.values ?? x);
        return {
          attribute_id: id !== '' && id != null ? String(id) : '',
          attribute_name: name ? String(name) : '',
          value
        };
      })
      .filter(Boolean);
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw).map(([k, v]) => ({
      attribute_id: k,
      attribute_name: k,
      value: formatScalar(v)
    }));
  }
  return [];
}

export function findRowValue(rows, attrId) {
  if (!attrId || !rows?.length) return '';
  const id = String(attrId);
  const r = rows.find((x) => String(x.attribute_id) === id);
  return r ? String(r.value ?? '') : '';
}
