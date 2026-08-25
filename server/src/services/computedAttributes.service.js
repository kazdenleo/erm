/**
 * Пересчёт вычисляемых атрибутов товара (формула → product_attribute_values).
 */

import { applyComputedAttributeValues, isComputedAttrType } from '../utils/attributeFormula.js';

function toId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadAttributes(execQuery) {
  const r = await execQuery(
    `SELECT id, name, type, formula, system_key
     FROM product_attributes
     ORDER BY id`
  );
  return r.rows || [];
}

async function loadProductFields(execQuery, productId) {
  const r = await execQuery(
    `SELECT cost, additional_expenses, min_price, weight, length, width, height, volume
     FROM products
     WHERE id = $1`,
    [productId]
  );
  return r.rows[0] || null;
}

async function loadValues(execQuery, productId) {
  try {
    const r = await execQuery(
      `SELECT attribute_id, value, is_manual
       FROM product_attribute_values
       WHERE product_id = $1`,
      [productId]
    );
    const values = {};
    const manual = {};
    for (const row of r.rows || []) {
      const id = String(row.attribute_id);
      if (row.value != null && row.value !== '') values[id] = String(row.value);
      if (row.is_manual === true) manual[id] = true;
    }
    return { values, manual };
  } catch (err) {
    if (!String(err?.message || '').includes('is_manual')) throw err;
    const r = await execQuery(
      `SELECT attribute_id, value
       FROM product_attribute_values
       WHERE product_id = $1`,
      [productId]
    );
    const values = {};
    for (const row of r.rows || []) {
      const id = String(row.attribute_id);
      if (row.value != null && row.value !== '') values[id] = String(row.value);
    }
    return { values, manual: {} };
  }
}

async function upsertValue(execQuery, productId, attrId, value, isManual) {
  const valStr = value == null ? '' : String(value);
  if (!valStr) {
    await execQuery(
      `DELETE FROM product_attribute_values WHERE product_id = $1 AND attribute_id = $2`,
      [productId, attrId]
    );
    return;
  }
  try {
    await execQuery(
      `INSERT INTO product_attribute_values (product_id, attribute_id, value, is_manual)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id, attribute_id)
       DO UPDATE SET value = EXCLUDED.value, is_manual = EXCLUDED.is_manual`,
      [productId, attrId, valStr, isManual === true]
    );
  } catch (err) {
    if (!String(err?.message || '').includes('is_manual')) throw err;
    await execQuery(
      `INSERT INTO product_attribute_values (product_id, attribute_id, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_id, attribute_id)
       DO UPDATE SET value = EXCLUDED.value`,
      [productId, attrId, valStr]
    );
  }
}

/**
 * @param {(sql: string, params?: any[]) => Promise<{ rows: any[] }>} execQuery
 * @param {number|string} productId
 */
export async function refreshComputedAttributeValues(execQuery, productId) {
  const id = toId(productId);
  if (!id || typeof execQuery !== 'function') return { values: {}, errors: {} };

  let attributes;
  try {
    attributes = await loadAttributes(execQuery);
  } catch (err) {
    if (String(err?.message || '').includes('formula') || String(err?.message || '').includes('system_key')) {
      return { values: {}, errors: {} };
    }
    throw err;
  }

  const computed = attributes.filter((a) => isComputedAttrType(a.type) && String(a.formula || '').trim());
  if (!computed.length) return { values: {}, errors: {} };

  const product = await loadProductFields(execQuery, id);
  if (!product) return { values: {}, errors: {} };

  const { values, manual } = await loadValues(execQuery, id);
  const { values: next, errors } = applyComputedAttributeValues({
    product,
    attributes,
    values,
    manual,
  });

  for (const attr of computed) {
    const aid = String(attr.id);
    if (manual[aid]) continue;
    const prev = values[aid] == null ? '' : String(values[aid]);
    const cur = next[aid] == null ? '' : String(next[aid]);
    if (prev === cur) continue;
    await upsertValue(execQuery, id, Number(attr.id), cur, false);
  }

  return { values: next, errors };
}

export default { refreshComputedAttributeValues };
