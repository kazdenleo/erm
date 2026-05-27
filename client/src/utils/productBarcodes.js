/** @typedef {'ozon'|'wb'|'ym'} MarketplaceCode */

export const BARCODE_MP_TOGGLES = [
  { code: 'ozon', label: 'OZ', title: 'Ozon — этикетки FBO', color: '#005bff' },
  { code: 'wb', label: 'WB', title: 'Wildberries — этикетки FBO', color: '#cb11ab' },
  { code: 'ym', label: 'ЯМ', title: 'Яндекс.Маркет — этикетки FBO', color: '#fc3f1d' },
];

export const EMPTY_BARCODE_ROW = { barcode: '', marketplaces: [] };

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
  if (typeof raw === 'string') {
    return { barcode: raw.trim(), marketplaces: [] };
  }
  if (typeof raw === 'object') {
    const barcode = String(raw.barcode ?? raw.value ?? '').trim();
    return {
      barcode,
      marketplaces: normalizeBarcodeMarketplaces(raw.marketplaces),
    };
  }
  return { ...EMPTY_BARCODE_ROW };
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
  const rows = barcodes.map(normalizeBarcodeRow);
  if (keepEmpty) return rows.length ? rows : [{ ...EMPTY_BARCODE_ROW }];
  return rows.filter((r) => r.barcode);
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
