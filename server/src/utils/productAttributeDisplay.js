/**
 * Значения выбранного атрибута товара для UI упаковки/сборки.
 */

import { query } from '../config/database.js';

/**
 * @param {number[]} productIds
 * @param {number|null|undefined} attributeId
 * @returns {Promise<Map<number, string>>} productId → display value
 */
export async function loadProductAttributeDisplayMap(productIds, attributeId) {
  const map = new Map();
  const aid = Number(attributeId);
  if (!Number.isFinite(aid) || aid <= 0) return map;
  const ids = [
    ...new Set(
      (productIds || [])
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (!ids.length) return map;

  const r = await query(
    `SELECT pav.product_id, pav.value
     FROM product_attribute_values pav
     WHERE pav.attribute_id = $1
       AND pav.product_id = ANY($2::bigint[])
       AND pav.value IS NOT NULL
       AND TRIM(pav.value) <> ''`,
    [aid, ids]
  );
  for (const row of r.rows || []) {
    const pid = Number(row.product_id);
    const val = row.value != null ? String(row.value).trim() : '';
    if (Number.isFinite(pid) && pid > 0 && val) map.set(pid, val);
  }
  return map;
}

/**
 * @param {number|string|null|undefined} profileId
 * @returns {Promise<number|null>}
 */
export async function loadPackingDisplayAttributeId(profileId) {
  const pid = profileId != null && profileId !== '' ? Number(profileId) : null;
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const r = await query(
    `SELECT packing_display_attribute_id
     FROM profiles
     WHERE id = $1
     LIMIT 1`,
    [pid]
  );
  const raw = r.rows?.[0]?.packing_display_attribute_id;
  const n = raw != null ? Number(raw) : null;
  return Number.isFinite(n) && n > 0 ? n : null;
}
