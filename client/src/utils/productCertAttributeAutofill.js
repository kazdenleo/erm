/**
 * Автоподстановка данных сертификата/декларации в атрибуты карточки МП.
 */

export function certSourceHasAnyDocument(certSource) {
  if (!certSource) return false;
  return Boolean(
    certSource.certificate?.number ||
      certSource.certificate?.validFrom ||
      certSource.certificate?.validTo ||
      certSource.declaration?.number ||
      certSource.declaration?.validFrom ||
      certSource.declaration?.validTo ||
      certSource.registration?.number ||
      certSource.registration?.validFrom ||
      certSource.registration?.validTo ||
      certSource.number ||
      certSource.validFrom ||
      certSource.validTo
  );
}

const DOC_TYPE_LABELS = {
  certificate: 'Сертификат соответствия',
  declaration: 'Декларация соответствия',
  registration: 'Свидетельство о государственной регистрации',
};

export function docTypeLabel(documentType) {
  const t = String(documentType || 'certificate').toLowerCase();
  return DOC_TYPE_LABELS[t] || DOC_TYPE_LABELS.certificate;
}

/**
 * Дата сертификата для характеристик WB: ДД.ММ.ГГГГ.
 * Одиночные цифры (3, 2) не считаем датой.
 * @param {unknown} raw
 * @returns {string}
 */
export function formatWbCertDate(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (dmy) return `${dmy[1].padStart(2, '0')}.${dmy[2].padStart(2, '0')}.${dmy[3]}`;
  return '';
}

function normalizeAttrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEmptyMarketplaceValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => isEmptyMarketplaceValue(x));
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function resolveDocForAttrName(attrName, certSource) {
  const n = normalizeAttrName(attrName);
  const hasDocKeyword = /(сертифик|декларац|свидетельств|сгр|документ|соответств)/.test(n);
  const explicitDeclaration = /декларац/.test(n);
  const explicitRegistration = /свидетельств/.test(n) || /\bсгр\b/.test(n);
  const explicitCertificate = /сертифик/.test(n);
  const mentionedTypesCount =
    (explicitDeclaration ? 1 : 0) + (explicitRegistration ? 1 : 0) + (explicitCertificate ? 1 : 0);
  const explicitType = mentionedTypesCount === 1;

  const docType = explicitDeclaration
    ? 'declaration'
    : explicitRegistration
      ? 'registration'
      : 'certificate';
  const doc = certSource?.[docType] || certSource?.certificate || {};

  return { n, hasDocKeyword, explicitType, doc, docType };
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * @param {Array} attributes
 * @param {object} certSource
 * @param {object} prevValues
 * @param {{ getAttrKey: Function, getAttrName: Function, formatDate?: Function, resolveEnumValue?: Function }} opts
 */
export function applyCertAutofillToAttributes(attributes, certSource, prevValues, opts) {
  if (!Array.isArray(attributes) || attributes.length === 0 || !certSource) {
    return prevValues;
  }
  if (!certSourceHasAnyDocument(certSource)) return prevValues;

  const getAttrKey = opts.getAttrKey;
  const getAttrName = opts.getAttrName;
  const formatDate = opts.formatDate || ((d) => (d != null ? String(d).trim() : ''));
  const resolveEnumValue = opts.resolveEnumValue;

  const fallbackNumber = firstNonEmpty(
    certSource.certificate?.number,
    certSource.declaration?.number,
    certSource.registration?.number,
    certSource.number
  );
  const fallbackFrom = firstNonEmpty(
    certSource.certificate?.validFrom,
    certSource.declaration?.validFrom,
    certSource.registration?.validFrom,
    certSource.validFrom
  );
  const fallbackTo = firstNonEmpty(
    certSource.certificate?.validTo,
    certSource.declaration?.validTo,
    certSource.registration?.validTo,
    certSource.validTo
  );

  const primaryDocType =
    certSource.primaryDocType ||
    (certSource.declaration?.number ? 'declaration' : null) ||
    (certSource.registration?.number ? 'registration' : null) ||
    'certificate';

  let changed = false;
  const next = { ...prevValues };
  // Реестр сертификатов — источник правды: при смене дат в сертификате
  // перезаписываем уже заполненные поля карточки (раньше заполняли только пустые).
  const overwrite = opts.overwrite !== false;

  const setIfChanged = (key, value) => {
    if (isEmptyMarketplaceValue(value)) return;
    const prev = next[key];
    const prevStr = prev == null ? '' : String(prev).trim();
    const nextStr = String(value).trim();
    if (prevStr === nextStr) return;
    next[key] = value;
    changed = true;
  };

  for (const attr of attributes) {
    const key = getAttrKey(attr);
    if (!key) continue;
    if (!overwrite && !isEmptyMarketplaceValue(next[key])) continue;

    const name = getAttrName(attr);
    const { hasDocKeyword, explicitType, doc } = resolveDocForAttrName(name, certSource);
    const n = normalizeAttrName(name);

    const isDocTypeAttr =
      /(тип|вид).*(документ|соответств)/.test(n) ||
      /document.*type/.test(n) ||
      (/тип/.test(n) && /(сертифик|декларац|свидетельств)/.test(n));

    if (isDocTypeAttr) {
      const label = docTypeLabel(primaryDocType);
      const resolved = resolveEnumValue ? resolveEnumValue(attr, label, { kind: 'doc_type' }) : label;
      setIfChanged(key, resolved);
      continue;
    }

    if (!hasDocKeyword) continue;

    const isNumberAttr = /номер/.test(n);
    const isRegDateAttr = /дата регистрац/.test(n);
    const isFromAttr = (/(дата начала|начал.*действ|дата выдач)/.test(n) || isRegDateAttr) && hasDocKeyword;
    const isToAttr =
      /(дата оконч|срок действ|действителен до|окончан.*действ|годен до)/.test(n) && hasDocKeyword;

    if (isNumberAttr && doc?.number) {
      setIfChanged(key, doc.number);
    } else if (isNumberAttr && !explicitType && fallbackNumber) {
      setIfChanged(key, fallbackNumber);
    } else if (isFromAttr && doc?.validFrom) {
      setIfChanged(key, formatDate(doc.validFrom));
    } else if (isFromAttr && !explicitType && fallbackFrom) {
      setIfChanged(key, formatDate(fallbackFrom));
    } else if (isToAttr && doc?.validTo) {
      setIfChanged(key, formatDate(doc.validTo));
    } else if (isToAttr && !explicitType && fallbackTo) {
      setIfChanged(key, formatDate(fallbackTo));
    }
  }

  return changed ? next : prevValues;
}

/**
 * Сертификаты бренда, подходящие для категории товара.
 * Нужна явная привязка к категории (бренд + категория только вместе).
 */
export function filterBrandCertsForCategory(certs, categoryId) {
  const list = Array.isArray(certs) ? certs : [];
  const cid = categoryId != null ? String(categoryId).trim() : '';
  if (!cid) return [];
  return list.filter((c) => {
    const ids = c.user_category_ids ?? c.userCategoryIds ?? [];
    if (!Array.isArray(ids) || ids.length === 0) return false;
    return ids.some((id) => String(id) === cid);
  });
}
