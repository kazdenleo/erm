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
  const s = String(dateOnly).trim();
  if (!s) return null;
  const day = s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day}T00:00:00.000Z`;
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

/** Ozon create принимает jpg/jpeg/png/pdf — webp/gif конвертировать нельзя здесь; отклоняем явно. */
export function isOzonCertificateFileAllowed(filename) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  return ['jpg', 'jpeg', 'png', 'pdf'].includes(ext);
}
