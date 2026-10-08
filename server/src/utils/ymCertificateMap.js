/**
 * Маппинг локальных сертификатов ERP → документы Яндекс.Маркета
 * (POST /v1/businesses/{businessId}/offers/documents/create).
 */

import { normalizeOzonCertificateNumber } from './ozonCertificateMap.js';

const LATIN_TO_CYRILLIC = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
};

function cyrillizeLookalikes(s) {
  return [...String(s || '').toUpperCase()].map((ch) => LATIN_TO_CYRILLIC[ch] || ch).join('');
}

/**
 * Маркет сверяет номер с реестром ФСА, где ТР ТС / ЕАЭС записаны кириллицей, кроме кодов стран:
 * «TC RU C-CN.AB29.A.05694» → «ТС RU С-CN.АВ29.А.05694». Номера другого формата не трогаем.
 */
export function toYmRegistryCertificateNumber(number) {
  const s = normalizeOzonCertificateNumber(number);
  const m = s.match(
    /^(ТС|ЕАЭС) (N )?([A-Za-z]{2}) ([СCДD])-([A-Za-z]{2})\.([A-Za-zА-Яа-яЁё0-9]{2,4})\.([A-Za-zА-Яа-яЁё])\.(\d{3,7}(?:\/\d{2})?)$/
  );
  if (!m) return s;
  const [, prefix, nPart = '', country, kind, origin, organ, series, serial] = m;
  const kindCyr = /[ДD]/i.test(kind) ? 'Д' : 'С';
  return `${prefix} ${nPart}${country.toUpperCase()} ${kindCyr}-${origin.toUpperCase()}.${cyrillizeLookalikes(organ)}.${cyrillizeLookalikes(series)}.${serial}`;
}

export const YM_DOC_TYPE_BY_ERP = {
  certificate: 'CONFORMITY_CERTIFICATE',
  declaration: 'CONFORMITY_DECLARATION',
  registration: 'STATE_REGISTRATION_CERTIFICATE',
};

export const YM_DOCUMENT_TYPES = [
  { code: 'CONFORMITY_CERTIFICATE', label: 'Сертификат соответствия' },
  { code: 'CONFORMITY_DECLARATION', label: 'Декларация о соответствии' },
  { code: 'STATE_REGISTRATION_CERTIFICATE', label: 'Свидетельство гос. регистрации' },
  { code: 'MEDICINAL_PRODUCT_CERTIFICATE', label: 'Документы для аптеки' },
  { code: 'BIOLOGICALLY_ACTIVE_ADDITIVE_CERTIFICATE', label: 'СГР БАД' },
  { code: 'MEDICAL_DEVICE_CERTIFICATE', label: 'РУ медицинского изделия' },
  { code: 'AGROCHEMICAL_PESTICIDE_CERTIFICATE', label: 'Регистрация пестицида/агрохимиката' },
];

export function mapErpDocumentTypeToYm(documentType, explicit = null) {
  const ex = String(explicit || '').trim();
  if (ex) return ex;
  const key = String(documentType || 'certificate').trim().toLowerCase();
  return YM_DOC_TYPE_BY_ERP[key] || YM_DOC_TYPE_BY_ERP.certificate;
}

/** Дата → YYYY-MM-DD для YM API. */
export function toYmDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  if (!s) return null;
  const isoDay = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDay) return isoDay[1];
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const d = String(parsed.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

export function parseYmCreateDocument(data, wantNumber) {
  const docs = data?.result?.documents || data?.documents || [];
  const want = String(wantNumber || '').trim();
  const list = Array.isArray(docs) ? docs : [];
  let hit = null;
  if (want) {
    hit = list.find((d) => String(d?.number || '').trim() === want) || null;
  }
  if (!hit) hit = list[0] || null;
  if (!hit) return null;
  const id = Number(hit.id ?? hit.documentId ?? hit.document_id);
  return {
    id: Number.isFinite(id) && id > 0 ? Math.trunc(id) : null,
    number: hit.number != null ? String(hit.number) : want,
    status: hit.status != null ? String(hit.status) : null,
    type: hit.type != null ? String(hit.type) : null,
  };
}

export function ymCreateErrors(data) {
  const errs = data?.result?.errors || data?.errors || [];
  return Array.isArray(errs) ? errs : [];
}

export function isYmDocumentAlreadyExistsError(err) {
  const code = String(err?.code || '').toUpperCase();
  if (code === 'DOCUMENT_ALREADY_EXISTS') return true;
  const msg = String(err?.message || err || '');
  return /ALREADY_EXISTS|уже существует/i.test(msg);
}
