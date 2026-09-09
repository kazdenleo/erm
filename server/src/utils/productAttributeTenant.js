/**
 * Видимость ERP-атрибутов по аккаунту.
 * Системные (system_key) — общие. Пользовательские — только свой profile_id.
 */

export function isSystemProductAttribute(row) {
  return String(row?.system_key || '').trim() !== '';
}

/**
 * @param {null|number|string} tid tenant profile id; null = супер-админ без фильтра
 */
export function productAttributeListFilter(tid, paramIndex = 1) {
  if (tid == null) {
    return { sql: 'TRUE', params: [] };
  }
  return {
    sql: `(COALESCE(btrim(system_key), '') <> '' OR profile_id = $${paramIndex})`,
    params: [tid],
  };
}

export function productAttributeOwnedSql(tid, paramIndex = 1) {
  return {
    sql: `(COALESCE(btrim(system_key), '') = '' AND profile_id = $${paramIndex})`,
    params: [tid],
  };
}
