/**
 * Проброс номера/дат сертификата в характеристики товаров (в т.ч. WB).
 * Известные charcID WB для сертификата/декларации стабильны в Content API.
 */

import { formatWbCertDate } from './wbCertDate.js';

/** @see WB subject charcs: номер / дата регистрации / дата окончания */
export const WB_CERT_CHARC = {
  certificateNumber: 15001136,
  declarationNumber: 15001135,
  dateFrom: 15001137,
  dateTo: 15001138,
};

/**
 * @param {unknown} raw
 * @returns {string|null} YYYY-MM-DD или null
 */
export function toDateOnly(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, '0');
    const d = String(raw.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return null;
}

/**
 * Значения для записи в wb_attributes (даты как ДД.ММ.ГГГГ).
 * @param {{ certificate_number?: string|null, document_type?: string|null, valid_from?: unknown, valid_to?: unknown }} cert
 */
export function wbCertAttributePatch(cert) {
  const number = String(cert?.certificate_number || '').trim();
  const docType = String(cert?.document_type || 'certificate').toLowerCase();
  const fromDmy = formatWbCertDate(toDateOnly(cert?.valid_from) || cert?.valid_from) || '';
  const toDmy = formatWbCertDate(toDateOnly(cert?.valid_to) || cert?.valid_to) || '';
  const patch = {};
  if (number) {
    if (docType === 'declaration') {
      patch[String(WB_CERT_CHARC.declarationNumber)] = number;
    } else {
      patch[String(WB_CERT_CHARC.certificateNumber)] = number;
    }
  }
  if (fromDmy) patch[String(WB_CERT_CHARC.dateFrom)] = fromDmy;
  if (toDmy) patch[String(WB_CERT_CHARC.dateTo)] = toDmy;
  return patch;
}

/**
 * Накладывает patch только на уже существующие ключи в attrs.
 * @param {object|null|undefined} attrs
 * @param {Record<string, string>} patch
 * @returns {{ next: object, changed: boolean }}
 */
export function mergeExistingCertKeys(attrs, patch) {
  const base =
    attrs && typeof attrs === 'object' && !Array.isArray(attrs) ? { ...attrs } : {};
  let changed = false;
  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) continue;
    const prev = base[key] == null ? '' : String(base[key]).trim();
    const next = value == null ? '' : String(value).trim();
    if (prev === next) continue;
    base[key] = next;
    changed = true;
  }
  return { next: base, changed };
}
