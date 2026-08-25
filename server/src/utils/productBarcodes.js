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
  if (s.toLowerCase().includes('[object')) return true;
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
    if (!s || CORRUPT_BARCODE_RE.test(s) || s.toLowerCase().includes('[object')) return '';
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
  AND LOWER(TRIM(bc.barcode)) NOT LIKE '%[object%'
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

/**
 * Разобрать сырые ШК (скалярры, массивы, «a;b» / «a,b»).
 * @param {unknown} raw
 * @returns {string[]}
 */
export function collectBarcodeStrings(raw) {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const parts =
      typeof item === 'string' && /[;,]/.test(item) ? item.split(/[;,]/) : [item];
    for (const part of parts) {
      const code = coerceBarcodeString(part);
      if (!code || isCorruptBarcodeString(code) || seen.has(code)) continue;
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/** @param {unknown} data — ответ getOzonProductInfo */
export function barcodesFromOzonCard(data) {
  if (!data || typeof data !== 'object') return [];
  return collectBarcodeStrings([
    data.barcode,
    ...(Array.isArray(data.barcodes) ? data.barcodes : []),
  ]);
}

/** @param {unknown} data — offer YM */
export function barcodesFromYmCard(data) {
  if (!data || typeof data !== 'object') return [];
  return collectBarcodeStrings(data.barcodes);
}

/**
 * Слить ШК с МП: не удаляет существующие (в т.ч. внутренние без иконок), не дублирует код —
 * только добавляет иконку маркетплейса или новую строку.
 * Важно: `existing` должен быть актуальным списком из БД (не undefined) —
 * иначе merge вернёт только коды МП, а products.update сделает DELETE+INSERT и затрёт локальные ШК.
 * @param {unknown} existing
 * @param {unknown} incomingCodes
 * @param {unknown} marketplace
 * @returns {{ barcode: string, marketplaces: MarketplaceCode[] }[]|null} null если изменений нет
 */
export function mergeBarcodesFromMarketplace(existing, incomingCodes, marketplace) {
  const incoming = collectBarcodeStrings(incomingCodes);
  if (!incoming.length) return null;
  // Явно пустой массив OK (у товара нет ШК); undefined/null — ошибка вызова, не затираем.
  if (existing == null) {
    return null;
  }
  const mp = normalizeBarcodeMarketplace(marketplace);
  /** @type {{ barcode: string, marketplaces: MarketplaceCode[] }[]} */
  const rows = normalizeBarcodeRows(existing).map((r) => ({
    barcode: r.barcode,
    marketplaces: [...(r.marketplaces || [])],
  }));
  const byCode = new Map(rows.map((r) => [r.barcode, r]));
  let changed = false;
  for (const code of incoming) {
    const row = byCode.get(code);
    if (row) {
      if (mp && !row.marketplaces.includes(mp)) {
        row.marketplaces.push(mp);
        changed = true;
      }
    } else {
      const next = { barcode: code, marketplaces: mp ? [mp] : [] };
      rows.push(next);
      byCode.set(code, next);
      changed = true;
    }
  }
  return changed ? rows : null;
}

export function hasMarketplaceBarcodeIcons(barcodes) {
  return normalizeBarcodeRows(barcodes).some(
    (r) => Array.isArray(r.marketplaces) && r.marketplaces.length > 0
  );
}

/** Нет ШК или ни один ШК не связан с маркетплейсом (нет иконок OZ/WB/ЯМ). */
export function needsGeneratedBarcodeForPush(barcodes) {
  const rows = normalizeBarcodeRows(barcodes);
  if (!rows.length) return true;
  return !hasMarketplaceBarcodeIcons(rows);
}

/**
 * Контрольная цифра EAN-13 по первым 12 цифрам.
 * @param {string} digits12
 * @returns {string|null}
 */
export function ean13CheckDigit(digits12) {
  const s = String(digits12 || '').replace(/\D/g, '');
  if (s.length !== 12) return null;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Собрать EAN-13 (префикс 200 — внутренний оборот).
 * @param {string} digits12
 * @returns {string|null}
 */
export function buildEan13(digits12) {
  const s = String(digits12 || '').replace(/\D/g, '');
  const check = ean13CheckDigit(s);
  return check == null ? null : `${s}${check}`;
}
