/** @typedef {'ozon'|'wb'|'ym'} MarketplaceCode */

export const BARCODE_MP_TOGGLES = [
  { code: 'ozon', label: 'OZ', title: 'Ozon — этикетки FBO', color: '#005bff' },
  { code: 'wb', label: 'WB', title: 'Wildberries — этикетки FBO', color: '#cb11ab' },
  { code: 'ym', label: 'ЯМ', title: 'Яндекс.Маркет — этикетки FBO', color: '#fc3f1d' },
];

export const EMPTY_BARCODE_ROW = { barcode: '', marketplaces: [] };

const CORRUPT_BARCODE_RE =
  /^\[object(\s+object)?\]$/i;

/**
 * Извлечь строку штрихкода из скаляра, объекта WB/Ozon или массива.
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
    if (!s || CORRUPT_BARCODE_RE.test(s)) return '';
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
  if (raw == null) return { ...EMPTY_BARCODE_ROW };
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
 * @param {{ keepEmpty?: boolean }} [opts]
 * @returns {{ barcode: string, marketplaces: MarketplaceCode[] }[]}
 */
export function normalizeBarcodeRows(barcodes, { keepEmpty = false } = {}) {
  if (!Array.isArray(barcodes) || !barcodes.length) {
    return keepEmpty ? [{ ...EMPTY_BARCODE_ROW }] : [];
  }
  const seen = new Set();
  const rows = [];
  for (const raw of barcodes) {
    const row = normalizeBarcodeRow(raw);
    if (!row.barcode) continue;
    if (seen.has(row.barcode)) continue;
    seen.add(row.barcode);
    rows.push(row);
  }
  if (keepEmpty) return rows.length ? rows : [{ ...EMPTY_BARCODE_ROW }];
  return rows;
}

/**
 * @param {unknown} barcodes
 * @returns {string[]}
 */
export function barcodeStringsFromProduct(barcodes) {
  return normalizeBarcodeRows(barcodes).map((r) => r.barcode);
}

/**
 * @param {unknown} barcodes
 * @returns {{ barcode: string, marketplaces: MarketplaceCode[] }[]}
 */
export function barcodesForForm(barcodes) {
  const rows = normalizeBarcodeRows(barcodes, { keepEmpty: true });
  return rows.length ? rows : [{ ...EMPTY_BARCODE_ROW }];
}

/**
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
 * @param {unknown} sizes — WB sizes[] из API
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
