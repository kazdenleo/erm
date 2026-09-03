/**
 * Ozon complex_attributes: несколько строк (марка / модель / модификация).
 */

import { ozonAttrValuesForApi } from './ozonManufacturerArticle.js';

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @returns {'mark'|'model'|'modification'|null} */
export function classifyOzonVehicleAttrRole(name) {
  const n = normName(name);
  if (!n) return null;
  if (n.includes('торгов') || n === 'бренд' || n.includes('brand')) return null;
  if (n === 'марка' || n.includes('марка авто') || (n.startsWith('марка ') && !n.includes('товар'))) {
    return 'mark';
  }
  if (n === 'модель' || n.includes('модель авто') || n.startsWith('модель ')) return 'model';
  if (n.includes('модификац')) return 'modification';
  return null;
}

function attrLinked(linkedEntries, attr) {
  const id = String(attr?.id ?? attr?.attribute_id ?? '');
  const name = normName(attr?.name ?? attr?.attribute_name);
  const list = Array.isArray(linkedEntries) ? linkedEntries : [];
  for (const e of list) {
    const eid = String(e?.id ?? '').trim();
    if (eid && eid === id) return true;
    const en = normName(e?.name);
    if (en && name && (name === en || name.includes(en) || en.includes(name))) return true;
  }
  return false;
}

/**
 * Группы «авто» из схемы Ozon + связи ERP-атрибута.
 * @returns {Array<{ complexId: number, attrs: { mark?, model?, modification? } }>}
 */
export function findOzonVehicleGroups(schemaAttrs, linkedOzonEntries = []) {
  const byComplex = new Map();
  for (const a of Array.isArray(schemaAttrs) ? schemaAttrs : []) {
    const role = classifyOzonVehicleAttrRole(a?.name ?? a?.attribute_name);
    if (!role) continue;
    const complexId = Number(a.attribute_complex_id ?? a.attributeComplexId ?? 0);
    if (complexId <= 0) continue;
    if (linkedOzonEntries.length && !attrLinked(linkedOzonEntries, a)) continue;
    if (!byComplex.has(complexId)) {
      byComplex.set(complexId, { complexId, attrs: {} });
    }
    byComplex.get(complexId).attrs[role] = {
      ...a,
      id: a.id ?? a.attribute_id,
      role,
    };
  }
  return [...byComplex.values()].filter((g) => g.attrs.mark && g.attrs.model);
}

export function emptyOzonComplexAttributes() {
  return { version: 1, groups: [] };
}

export function normalizeOzonComplexAttributes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyOzonComplexAttributes();
  }
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map((g) => ({
        complexId: Number(g.complexId ?? g.complex_id ?? 0),
        rows: Array.isArray(g.rows)
          ? g.rows.map((row) => ({
              mark: String(row?.mark ?? '').trim(),
              model: String(row?.model ?? '').trim(),
              modification: String(row?.modification ?? '').trim(),
            }))
          : [],
      }))
    : [];
  return { version: 1, groups: groups.filter((g) => g.complexId > 0) };
}

export function emptyVehicleRow() {
  return { mark: '', model: '', modification: '' };
}

export function vehicleGroupRows(stored, complexId) {
  const data = normalizeOzonComplexAttributes(stored);
  const g = data.groups.find((x) => x.complexId === Number(complexId));
  if (g?.rows?.length) return g.rows.map((r) => ({ ...r }));
  return [emptyVehicleRow()];
}

export function setVehicleGroupRows(stored, complexId, rows) {
  const data = normalizeOzonComplexAttributes(stored);
  const cid = Number(complexId);
  const cleanRows = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      mark: String(r?.mark ?? '').trim(),
      model: String(r?.model ?? '').trim(),
      modification: String(r?.modification ?? '').trim(),
    }))
    .filter((r) => r.mark || r.model || r.modification);
  const idx = data.groups.findIndex((g) => g.complexId === cid);
  const nextGroup = { complexId: cid, rows: cleanRows.length ? cleanRows : [emptyVehicleRow()] };
  if (idx >= 0) data.groups[idx] = nextGroup;
  else data.groups.push(nextGroup);
  return data;
}

/** Id атрибутов Ozon, которые уходят только через complex_attributes. */
export function ozonVehicleAttrIds(stored, vehicleGroups) {
  const ids = new Set();
  const data = normalizeOzonComplexAttributes(stored);
  for (const vg of vehicleGroups || []) {
    for (const role of ['mark', 'model', 'modification']) {
      const a = vg.attrs?.[role];
      if (a?.id != null) ids.add(Number(a.id));
    }
    const g = data.groups.find((x) => x.complexId === vg.complexId);
    if (g?.rows?.some((r) => r.mark || r.model || r.modification)) {
      for (const role of ['mark', 'model', 'modification']) {
        const a = vg.attrs?.[role];
        if (a?.id != null) ids.add(Number(a.id));
      }
    }
  }
  return ids;
}

/**
 * Payload для complex_attributes Ozon API.
 * @returns {Array<{ attributes: object[] }>}
 */
export function buildOzonComplexAttributesApiPayload(stored, vehicleGroups) {
  const data = normalizeOzonComplexAttributes(stored);
  const out = [];
  for (const vg of vehicleGroups || []) {
    const g = data.groups.find((x) => x.complexId === vg.complexId);
    if (!g) continue;
    for (const row of g.rows || []) {
      if (!row.mark && !row.model && !row.modification) continue;
      const nested = [];
      for (const role of ['mark', 'model', 'modification']) {
        const attr = vg.attrs?.[role];
        const val = String(row[role] ?? '').trim();
        if (!attr?.id || !val) continue;
        const values = ozonAttrValuesForApi(Number(attr.id), val, attr);
        if (!values?.length) continue;
        nested.push({
          complex_id: vg.complexId,
          id: Number(attr.id),
          values,
        });
      }
      if (nested.length) out.push({ attributes: nested });
    }
  }
  return out;
}

/** Разбор complex_attributes / attributes с complex_id из ответа Ozon. */
export function parseOzonComplexFromCard(complexAttributes, flatAttributes, vehicleGroups) {
  const groups = findOzonVehicleGroups(
    (vehicleGroups || []).flatMap((vg) => Object.values(vg.attrs || {})),
    []
  );
  if (!groups.length && vehicleGroups?.length) {
    // use provided vehicleGroups schema
  }
  const schemaGroups = vehicleGroups?.length ? vehicleGroups : groups;
  if (!schemaGroups.length) return emptyOzonComplexAttributes();

  const result = emptyOzonComplexAttributes();

  const ingestRow = (complexId, attrId, storedVal) => {
    const vg = schemaGroups.find((g) => g.complexId === Number(complexId));
    if (!vg) return;
    const attr = Object.values(vg.attrs).find((a) => Number(a.id) === Number(attrId));
    if (!attr?.role) return;
    let g = result.groups.find((x) => x.complexId === Number(complexId));
    if (!g) {
      g = { complexId: Number(complexId), rows: [] };
      result.groups.push(g);
    }
    let row = g.rows[g.rows.length - 1];
    if (!row || row[attr.role]) {
      row = emptyVehicleRow();
      g.rows.push(row);
    }
    row[attr.role] = storedVal;
  };

  const complexList = Array.isArray(complexAttributes) ? complexAttributes : [];
  for (const block of complexList) {
    const nested = Array.isArray(block?.attributes) ? block.attributes : [];
    const row = emptyVehicleRow();
    let complexId = 0;
    for (const a of nested) {
      complexId = Number(a.complex_id ?? a.complexId ?? complexId);
      const id = Number(a.id ?? a.attribute_id);
      const vg = schemaGroups.find((g) => g.complexId === complexId);
      if (!vg) continue;
      const attr = Object.values(vg.attrs).find((x) => Number(x.id) === id);
      if (!attr?.role) continue;
      const vals = Array.isArray(a.values) ? a.values : [];
      const v0 = vals[0];
      const text =
        v0?.dictionary_value_id != null && String(v0.dictionary_value_id).trim() !== ''
          ? String(v0.dictionary_value_id)
          : String(v0?.value ?? '').trim();
      if (text) row[attr.role] = text;
    }
    if (complexId > 0 && (row.mark || row.model || row.modification)) {
      let g = result.groups.find((x) => x.complexId === complexId);
      if (!g) {
        g = { complexId, rows: [] };
        result.groups.push(g);
      }
      g.rows.push(row);
    }
  }

  if (!result.groups.length) {
    const flat = Array.isArray(flatAttributes) ? flatAttributes : [];
    for (const a of flat) {
      const complexId = Number(a.complex_id ?? a.complexId ?? 0);
      if (complexId <= 0) continue;
      const id = Number(a.id ?? a.attribute_id);
      const vals = Array.isArray(a.values) ? a.values : [];
      for (const v of vals) {
        const text =
          v?.dictionary_value_id != null && String(v.dictionary_value_id).trim() !== ''
            ? String(v.dictionary_value_id)
            : String(v?.value ?? '').trim();
        if (text) ingestRow(complexId, id, text);
      }
    }
  }

  return result;
}

export function countVehicleRows(stored) {
  const data = normalizeOzonComplexAttributes(stored);
  return data.groups.reduce(
    (n, g) => n + (g.rows || []).filter((r) => r.mark || r.model || r.modification).length,
    0
  );
}
