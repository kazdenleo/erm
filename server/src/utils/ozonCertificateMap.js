/**
 * Маппинг локальных сертификатов ERP → поля Certification API Ozon.
 */

export const OZON_DOC_TYPE_BY_ERP = {
  certificate: 'certificate_of_conformity',
  declaration: 'declaration',
  registration: 'certificate_of_registration',
};

export const OZON_ACCORDANCE_TYPES = [
  { code: 'technical_regulations_cu', label: 'Технический регламент ТС' },
  { code: 'technical_regulations_rf', label: 'Технический регламент РФ' },
  { code: 'gost', label: 'ГОСТ' },
];

const TYPES_NEEDING_ACCORDANCE = new Set([
  'certificate_of_conformity',
  'declaration',
  'safety_data_sheet',
]);

export function mapErpDocumentTypeToOzon(documentType) {
  const key = String(documentType || 'certificate').trim().toLowerCase();
  return OZON_DOC_TYPE_BY_ERP[key] || OZON_DOC_TYPE_BY_ERP.certificate;
}

/**
 * Эвристика типа соответствия по номеру документа.
 * ЕАЭС / ТР ТС → technical_regulations_cu; ГОСТ → gost; иначе ТР ТС.
 */
export function guessAccordanceTypeCode(certificateNumber, explicit = null) {
  const explicitCode = String(explicit || '').trim();
  if (explicitCode) return explicitCode;

  const n = String(certificateNumber || '').toUpperCase();
  if (/ГОСТ|GOST/.test(n)) return 'gost';
  if (/ТР\s*РФ|TECHNICAL_REGULATIONS_RF/.test(n)) return 'technical_regulations_rf';
  if (/ЕАЭС|EAEU|ТР\s*ТС|ТР\s*ЕАЭС|CU\s*TR|TECHNICAL_REGULATIONS_CU/.test(n)) {
    return 'technical_regulations_cu';
  }
  return 'technical_regulations_cu';
}

export function needsAccordanceType(typeCode) {
  return TYPES_NEEDING_ACCORDANCE.has(String(typeCode || '').trim());
}

/** Дата → ISO UTC полуночи (как ожидает Ozon). */
export function toOzonDateTime(dateOnly) {
  if (dateOnly == null || dateOnly === '') return null;
  if (dateOnly instanceof Date) {
    if (Number.isNaN(dateOnly.getTime())) return null;
    const y = dateOnly.getUTCFullYear();
    const m = String(dateOnly.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dateOnly.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}T00:00:00.000Z`;
  }
  const s = String(dateOnly).trim();
  if (!s) return null;
  // ISO / DATE: 2024-01-15 или 2024-01-15T...
  const isoDay = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDay) return `${isoDay[1]}T00:00:00.000Z`;
  // Date#toString() и подобные — через Date.parse
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const d = String(parsed.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}T00:00:00.000Z`;
  }
  return null;
}

export function buildOzonCertificateName(cert = {}) {
  const brand = String(cert.brand_name || '').trim();
  const number = String(cert.certificate_number || '').trim();
  const typeLabel =
    cert.document_type === 'declaration'
      ? 'Декларация'
      : cert.document_type === 'registration'
        ? 'СГР'
        : 'Сертификат';
  const base = brand ? `${typeLabel} ${brand}` : typeLabel;
  const withNumber = number ? `${base} ${number}` : base;
  return withNumber.slice(0, 100);
}

export function parseOzonCertificateCreateId(data) {
  if (data == null) return null;
  if (typeof data === 'number' && Number.isFinite(data) && data > 0) return Math.trunc(data);
  if (typeof data === 'string' && /^\d+$/.test(data.trim())) return Number(data.trim());

  const candidates = [
    data.result,
    data.id,
    data.certificate_id,
    data.certificateId,
    data?.result?.certificate_id,
    data?.result?.id,
    data?.result?.certificateId,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return null;
}

export function mimeForCertificateFilename(filename) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

const LATIN_TO_CYRILLIC_LOOKALIKE = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
};

/**
 * Ozon v2 проверяет номер по маске с кириллическим префиксом («ТС RU С-…», «ЕАЭС RU …», «РОСС RU …»),
 * а в документах его часто набирают латиницей («TC RU C-…»). Меняем латинские двойники только в префиксе.
 */
export function normalizeOzonCertificateNumber(number) {
  const s = String(number || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const m = s.match(/^(\S+)(\s.*)?$/);
  const head = m[1];
  const rest = m[2] || '';
  if (/^EAEU$/i.test(head)) return `ЕАЭС${rest}`;
  if (!/^[A-Za-zА-Яа-яЁё]+$/.test(head)) return s;
  const upper = head.toUpperCase();
  const hasCyrillic = /[А-ЯЁ]/.test(upper);
  const allLookalike = [...upper].every((ch) => /[А-ЯЁ]/.test(ch) || LATIN_TO_CYRILLIC_LOOKALIKE[ch]);
  if (!allLookalike) return s;
  const converted = [...upper].map((ch) => LATIN_TO_CYRILLIC_LOOKALIKE[ch] || ch).join('');
  if (['ТС', 'ЕАЭС', 'РОСС'].includes(converted) || hasCyrillic) return `${converted}${rest}`;
  return s;
}

/** certificate_of_conformity → CERTIFICATE_OF_CONFORMITY (enum v2/product/certificate/create). */
export function toOzonV2CertificateType(typeCode) {
  return String(typeCode || 'certificate_of_conformity').trim().toUpperCase();
}

/** Ozon v2: EAEU (ТР ТС / ЕАЭС) или NATIONAL (ТР РФ / ГОСТ Р). Префикс номера важнее выбора в форме. */
export function toOzonV2AccordanceType(normalizedNumber, accordanceTypeCode) {
  const n = String(normalizedNumber || '');
  if (/^(ТС|ЕАЭС)\s/.test(n)) return 'EAEU';
  if (/^РОСС\s/.test(n)) return 'NATIONAL';
  return String(accordanceTypeCode || '') === 'technical_regulations_cu' ? 'EAEU' : 'NATIONAL';
}

const CYRILLIC_TO_LATIN_LOOKALIKE = Object.fromEntries(
  Object.entries(LATIN_TO_CYRILLIC_LOOKALIKE).map(([lat, cyr]) => [cyr, lat])
);

/**
 * Страна органа сертификации из номера: «ЕАЭС RU С-…» → RU, «ЕАЭС KG417/039…» → KG, «ЕАЭС.KZ.…» → KZ.
 * Ozon проверяет номер по маскам выбранной страны.
 */
export function ozonCertificateCountry(normalizedNumber) {
  const m = String(normalizedNumber || '')
    .toUpperCase()
    .match(/^(?:ТС|ЕАЭС|РОСС)[\s.]*(?:№\s*|N\s+)?([A-ZА-ЯЁ]{2})(?![A-ZА-ЯЁ])/);
  if (!m) return 'RU';
  const code = [...m[1]].map((ch) => CYRILLIC_TO_LATIN_LOOKALIKE[ch] || ch).join('');
  return /^[A-Z]{2}$/.test(code) ? code : 'RU';
}

/** 2024-01-15 → { year: 2024, month: 1, day: 15 } (google.type.Date в expired_date.date). */
export function toOzonDateParts(dateOnly) {
  const iso = toOzonDateTime(dateOnly);
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { year: y, month: m, day: d };
}

export function buildOzonV2CertificateParams({
  typeCode,
  number,
  name,
  accordanceTypeCode,
  issueDate,
  expireDate,
  files = [],
}) {
  const normalizedNumber = normalizeOzonCertificateNumber(number);
  const params = {
    certificate_type: toOzonV2CertificateType(typeCode),
    name,
    number: normalizedNumber,
    issue_date: toOzonDateTime(issueDate),
  };
  if (needsAccordanceType(typeCode)) {
    params.certificate_country = ozonCertificateCountry(normalizedNumber);
    params.accordance_type = toOzonV2AccordanceType(normalizedNumber, accordanceTypeCode);
  }
  const expireParts = toOzonDateParts(expireDate);
  params.expired_date = expireParts ? { date: expireParts } : { infinite: true };
  if (files.length) params.files = files;
  return params;
}

const OZON_V2_PARAM_LABELS = {
  CERTIFICATE_TYPE: 'Тип документа',
  CERTIFICATE_COUNTRY: 'Страна',
  ACCORDANCE_TYPE: 'Тип соответствия',
  NAME: 'Название',
  NUMBER: 'Номер',
  ISSUE_DATE: 'Дата выдачи',
  EXPIRED_DATE: 'Срок действия',
  INFINITE: 'Бессрочный',
  LINK_TO_REGISTRY: 'Ссылка на реестр',
  FILES: 'Файл',
  SKUS: 'Товары',
};

/** Человекочитаемые ошибки из ответа v2 create (params[].state != VALID). */
export function describeOzonV2CreateErrors(data) {
  const params = Array.isArray(data?.params) ? data.params : [];
  return params
    .filter((p) => p && p.state && p.state !== 'VALID')
    .map((p) => {
      const label = OZON_V2_PARAM_LABELS[p.name] || p.name;
      let text = `${label}: ${p.error || p.state}`;
      if (p.name === 'NUMBER' && Array.isArray(p.number_mask) && p.number_mask.length) {
        text += ` (ожидаемый формат: ${p.number_mask.join(' или ')})`;
      }
      return text;
    });
}

/** Ozon create принимает jpg/jpeg/png/pdf — webp/gif конвертировать нельзя здесь; отклоняем явно. */
export function isOzonCertificateFileAllowed(filename) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  return ['jpg', 'jpeg', 'png', 'pdf'].includes(ext);
}
