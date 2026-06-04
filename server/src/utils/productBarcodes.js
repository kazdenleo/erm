/** @typedef {'ozon'|'wb'|'ym'} MarketplaceCode */

export const BARCODE_MP_CODES = ['ozon', 'wb', 'ym'];

/**
 * Сопоставление только по цифрам (EAN/GTIN). Для артикулов вида DT-00230 — только точное совпадение строки.
 * @param {unknown} code
 * @returns {boolean}
 */
export function shouldUseBarcodeDigitFallback(code) {
  const s = String(code ?? '').trim();
  if (!s || !/\d/.test(s)) return false;
  return !/[a-zA-Z]/.test(s);
}

const CORRUPT_BARCODE_RE =
  /^\[object(\s+object)?\]$/i;

/** Битые значения из String(object) / WB sizes[].skus и т.п. */
export function isCorruptBarcodeString(raw) {
  if (raw == null) return true;
  if (typeof raw === 'object') {
    const extracted = coerceBarcodeString(raw);
    return !extracted;
  }
  const s = String(raw).trim();
  if (!s) return true;
  if (CORRUPT_BARCODE_RE.test(s)) return true;
  if (/\[object[\s\]]/i.test(s)) return true;
  if (/^object$/i.test(s)) return true;
  return false;
}

/**
 * Извлечь строку штрихкода из скаляра, объекта WB/Ozon ({ sku, barcode, … }) или массива.
 * @param {unknown} raw
 * @returns {string}
 */
export function coerceBarcodeString(raw) {
  if (raw == null) return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const s = String(Math.trunc(raw)).trim();
    return CORRUPT_BARCODE_RE.test(s) ? '' : s;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || CORRUPT_BARCODE_RE.test(s) || /\[object/i.test(s)) return '';
    return s;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const s = coerceBarcodeString(item);
      if (s) return s;
    }
    return '';
  }
  if (typeof raw === 'object') {
    const o = /** @type {Record<string, unknown>} */ (raw);
    const keys = [
      'barcode',
      'Barcode',
      'sku',
      'Sku',
      'SKU',
      'ean',
      'EAN',
      'gtin',
      'GTIN',
      'value',
      'code',
      'id',
      'nmId',
      'nmID',
      'nm_id',
    ];
    for (const k of keys) {
      if (k in o) {
        const s = coerceBarcodeString(o[k]);
        if (s) return s;
      }
    }
    return '';
  }
  const s = String(raw).trim();
  if (!s || CORRUPT_BARCODE_RE.test(s)) return '';
  return s;
}

/**
 * @param {unknown} v
 * @returns {MarketplaceCode|null}
 */
export function normalizeBarcodeMarketplace(v) {
  const m = String(v || '').trim().toLowerCase();
  if (m === 'ozon') return 'ozon';
  if (m === 'wb' || m === 'wildberries') return 'wb';
  if (m === 'ym' || m === 'yandex' || m === 'yandexmarket') return 'ym';
  return null;
}

/**
 * @param {unknown} list
 * @returns {MarketplaceCode[]}
 */
export function normalizeBarcodeMarketplaces(list) {
  const arr = Array.isArray(list) ? list : [];
  /** @type {MarketplaceCode[]} */
  const out = [];
  for (const x of arr) {
    const mp = normalizeBarcodeMarketplace(x);
    if (mp && !out.includes(mp)) out.push(mp);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ barcode: string, marketplaces: MarketplaceCode[] }}
 */
export function normalizeBarcodeRow(raw) {
  if (raw == null) return { barcode: '', marketplaces: [] };
  if (typeof raw === 'string' || typeof raw === 'number') {
    return { barcode: coerceBarcodeString(raw), marketplaces: [] };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const o = /** @type {Record<string, unknown>} */ (raw);
    return {
      barcode: coerceBarcodeString(o.barcode ?? o.value ?? o),
      marketplaces: normalizeBarcodeMarketplaces(o.marketplaces),
    };
  }
  return { barcode: coerceBarcodeString(raw), marketplaces: [] };
}

/**
 * @param {unknown} barcodes
 * @returns {{ barcode: string, marketplaces: MarketplaceCode[] }[]}
 */
export function normalizeBarcodeRows(barcodes) {
  if (!Array.isArray(barcodes)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of barcodes) {
    const row = normalizeBarcodeRow(raw);
    if (!row.barcode || isCorruptBarcodeString(row.barcode) || seen.has(row.barcode)) continue;
    seen.add(row.barcode);
    out.push(row);
  }
  return out;
}

/** SQL-фрагмент: исключить битые штрихкоды в таблице barcodes (alias bc). */
export const BARCODES_NOT_CORRUPT_SQL = `(
  TRIM(bc.barcode) <> ''
  AND TRIM(bc.barcode) !~* '^\\\\[object'
  AND LOWER(TRIM(bc.barcode)) NOT IN ('object', '[object object]')
)`;

/**
 * @param {unknown} barcodes
 * @returns {string[]}
 */
export function barcodeStringsFromProduct(barcodes) {
  return normalizeBarcodeRows(barcodes).map((r) => r.barcode);
}

/**
 * @param {unknown} raw
 * @returns {MarketplaceCode[]}
 */
export function parseBarcodesMarketplacesColumn(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return normalizeBarcodeMarketplaces(raw);
  if (typeof raw === 'string') {
    try {
      return normalizeBarcodeMarketplaces(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  if (typeof raw === 'object') return normalizeBarcodeMarketplaces(raw);
  return [];
}

/**
 * ШК для печати этикетки: сначала с выбранным МП, иначе внутренний (без МП), иначе первый.
 * @param {unknown} barcodes
 * @param {unknown} marketplace
 * @returns {string|null}
 */
export function pickBarcodeForMarketplace(barcodes, marketplace = null) {
  const rows = normalizeBarcodeRows(barcodes);
  if (!rows.length) return null;
  const mp = normalizeBarcodeMarketplace(marketplace);
  if (mp) {
    const tagged = rows.filter((r) => r.marketplaces.includes(mp));
    if (tagged.length) return tagged[0].barcode;
  }
  const internal = rows.filter((r) => !r.marketplaces.length);
  if (internal.length) return internal[0].barcode;
  return rows[0].barcode;
}

/**
 * Штрихкоды из ответа WB (sizes[].skus — часто объекты, не строки).
 * @param {unknown} sizes
 * @returns {string[]}
 */
export function barcodesFromWbSizes(sizes) {
  if (!Array.isArray(sizes)) return [];
  const skus = sizes.flatMap((s) => (Array.isArray(s?.skus) ? s.skus : []));
  const seen = new Set();
  const out = [];
  for (const item of skus) {
    const code = coerceBarcodeString(item);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}
