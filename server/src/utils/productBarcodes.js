/** @typedef {'ozon'|'wb'|'ym'} MarketplaceCode */

export const BARCODE_MP_CODES = ['ozon', 'wb', 'ym'];

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
  return { barcode: '', marketplaces: [] };
}

/**
 * @param {unknown} barcodes
 * @returns {{ barcode: string, marketplaces: MarketplaceCode[] }[]}
 */
export function normalizeBarcodeRows(barcodes) {
  if (!Array.isArray(barcodes)) return [];
  return barcodes.map(normalizeBarcodeRow).filter((r) => r.barcode);
}

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
