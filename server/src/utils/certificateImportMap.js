/**
 * Импорт сертификатов из кабинетов Ozon / Яндекс.Маркета: ключ дедупликации и маппинг полей.
 */

import { normalizeOzonCertificateNumber } from './ozonCertificateMap.js';

const LATIN_TO_CYRILLIC = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
};

/**
 * Один и тот же документ в разных кабинетах и у нас набран по-разному
 * («TC RU C-CN.AB29.A.05694» / «ТС RU С-CN.АВ29.А.05694»): сравниваем без пробелов и с единым алфавитом.
 */
export function certificateNumberKey(number) {
  const s = normalizeOzonCertificateNumber(number).toUpperCase().replace(/№/g, 'N').replace(/\s+/g, '');
  return [...s].map((ch) => LATIN_TO_CYRILLIC[ch] || ch).join('');
}

const OZON_TYPE_TO_ERP = {
  certificate_of_conformity: 'certificate',
  declaration: 'declaration',
  certificate_of_registration: 'registration',
  registration_certificate: 'registration',
};

const YM_TYPE_TO_ERP = {
  CONFORMITY_CERTIFICATE: 'certificate',
  CONFORMITY_DECLARATION: 'declaration',
  STATE_REGISTRATION_CERTIFICATE: 'registration',
};

export function ozonTypeToErp(typeCode) {
  return OZON_TYPE_TO_ERP[String(typeCode || '').toLowerCase()] || 'certificate';
}

export function ymTypeToErp(type) {
  return YM_TYPE_TO_ERP[String(type || '').toUpperCase()] || 'certificate';
}

/** ISO-дата → YYYY-MM-DD; пустые и «нулевые» даты Ozon (0001-01-01) → null. */
export function dateOnlyOrNull(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || Number(m[1]) < 1900) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Склеивает документы двух кабинетов по номеру.
 * @returns {Array<{ key, number, documentType, validFrom, validTo, ozon, ym }>}
 */
export function mergeMarketplaceCertificates(ozonRows = [], ymDocs = []) {
  const byKey = new Map();
  const entry = (number) => {
    const key = certificateNumberKey(number);
    if (!key) return null;
    if (!byKey.has(key)) {
      byKey.set(key, { key, number: String(number).trim(), documentType: null, validFrom: null, validTo: null, ozon: null, ym: null });
    }
    return byKey.get(key);
  };
  for (const row of ozonRows) {
    const e = entry(row?.certificate_number);
    if (!e || e.ozon) continue;
    e.ozon = row;
    e.documentType = e.documentType || ozonTypeToErp(row.type_code);
    e.validFrom = e.validFrom || dateOnlyOrNull(row.issue_date);
    e.validTo = e.validTo || dateOnlyOrNull(row.expire_date);
  }
  for (const doc of ymDocs) {
    const e = entry(doc?.number);
    if (!e || e.ym) continue;
    e.ym = doc;
    e.documentType = e.documentType || ymTypeToErp(doc.type);
    e.validFrom = e.validFrom || dateOnlyOrNull(doc.activeFromDate);
    e.validTo = e.validTo || dateOnlyOrNull(doc.activeToDate);
  }
  return [...byKey.values()];
}

/** Самый частый бренд среди привязанных товаров и категории товаров этого бренда. */
export function inferBrandAndCategories(products = []) {
  const brandCounts = new Map();
  for (const p of products) {
    const b = Number(p?.brand_id);
    if (Number.isFinite(b) && b > 0) brandCounts.set(b, (brandCounts.get(b) || 0) + 1);
  }
  if (!brandCounts.size) return { brandId: null, categoryIds: [] };
  const brandId = [...brandCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const categoryIds = [
    ...new Set(
      products
        .filter((p) => Number(p?.brand_id) === brandId)
        .map((p) => Number(p?.user_category_id))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ].sort((a, b) => a - b);
  return { brandId, categoryIds };
}
