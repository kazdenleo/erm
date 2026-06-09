/**
 * Импорт закупки из Excel: артикул + количество, суммирование дублей, снятие префикса поставщика.
 */

import ExcelJS from 'exceljs';
import { query } from '../config/database.js';
import suppliersService from './suppliers.service.js';
import purchasesService from './purchases.service.js';

function normalizeCellValue(cell) {
  if (!cell) return '';
  let v = cell.value;
  if (v == null || v === '') {
    const text = cell.text != null ? String(cell.text).trim() : '';
    if (text) return text;
    return '';
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) {
    const d = v;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'object') {
    if (v.richText && Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return normalizeCellValue({ value: v.result });
  }
  return String(v).trim();
}

/** Нормализация артикула из ячейки (дефисы, невидимые символы). */
function normalizeRawArticle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[\u200b-\u200d\u2060\uFEFF]/g, '')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
}

/** Единый ключ для суммирования строк Excel (одинаковый артикул в файле → одна позиция). */
function normalizeImportArticleKey(value) {
  return normalizeRawArticle(value).replace(/\s+/g, '').toLowerCase();
}

/** Последняя строка с данными (rowCount в ExcelJS иногда меньше реального хвоста файла). */
function getWorksheetLastDataRow(worksheet, startRow = 1) {
  const reported = worksheet.rowCount || 0;
  let last = Math.max(reported, startRow);
  let emptyStreak = 0;
  const maxScan = Math.max(reported + 50, startRow + 50, 50000);

  for (let r = startRow; r <= maxScan; r++) {
    const row = worksheet.getRow(r);
    const { rawArticle, qty } = parseImportRowCells(row);
    const article = normalizeImportArticleKey(rawArticle);
    if (article || qty > 0) {
      last = r;
      emptyStreak = 0;
      continue;
    }
    emptyStreak += 1;
    if (r > last + 5 && emptyStreak >= 8) break;
  }
  return last;
}

function rowToObject(worksheet, rowNum, keyRow) {
  const row = worksheet.getRow(rowNum);
  const obj = {};
  keyRow.eachCell({ includeEmpty: true }, (cell, col) => {
    let key = normalizeCellValue(cell).toLowerCase().replace(/\s+/g, '_').replace(/^\ufeff/, '');
    if (!key) return;
    obj[key] = normalizeCellValue(row.getCell(col));
  });
  return obj;
}

function cellLooksLikeImportHeaderLabel(value) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (!v) return false;
  if (v === 'sku' || v === 'qty') return true;
  if (/^(артикул|article|количество|quantity)$/.test(v)) return true;
  if (/^(себестоимость|себ-?сть|cost|purchase_price|purchaseprice|цена)$/.test(v)) return true;
  if (/^кол\.?$/.test(v)) return true;
  return false;
}

function rowHasImportHeaders(worksheet, rowNum) {
  const row = worksheet.getRow(rowNum);
  let headerCells = 0;
  row.eachCell({ includeEmpty: false }, (c) => {
    if (cellLooksLikeImportHeaderLabel(normalizeCellValue(c))) headerCells += 1;
  });
  return headerCells >= 2;
}

/** Строка с заголовками колонок (если есть) или null — тогда два столбца без шапки. */
function findHeaderRow(worksheet) {
  for (let r = 1; r <= Math.min(30, worksheet.rowCount || 30, getWorksheetLastDataRow(worksheet, 1)); r++) {
    if (rowHasImportHeaders(worksheet, r)) {
      return worksheet.getRow(r);
    }
  }
  return null;
}

/** Себестоимость из ячейки (руб., допускаются копейки). */
function parseCost(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    return Math.round(val * 100) / 100;
  }
  const s = String(val)
    .trim()
    .replace(/^[''`\u2019]+/, '')
    .replace(/\u00a0/g, '')
    .replace(/\s/g, '')
    .replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function parseCostFromCell(cell) {
  if (!cell) return null;
  if (cell.value != null && typeof cell.value === 'object' && cell.value.result != null) {
    const c = parseCost(cell.value.result);
    if (c != null) return c;
  }
  if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
    return parseCost(cell.value);
  }
  const fromValue = parseCost(normalizeCellValue(cell));
  if (fromValue != null) return fromValue;
  if (cell.text != null && String(cell.text).trim() !== '') {
    return parseCost(cell.text);
  }
  return null;
}

function parseQuantity(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val > 0 ? Math.floor(val) : 0;
  }
  const s = String(val)
    .trim()
    .replace(/^[''`\u2019]+/, '')
    .replace(/\u00a0/g, '')
    .replace(/\s/g, '')
    .replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isPureQuantityText(value) {
  return /^[''`\u2019]?\d+([.,]\d+)?$/.test(
    String(value ?? '')
      .trim()
      .replace(/\u00a0/g, '')
      .replace(/\s/g, '')
  );
}

/** Количество из ячейки (в т.ч. «число как текст» в Excel). */
function parseQuantityFromCell(cell) {
  if (!cell) return 0;
  if (cell.value != null && typeof cell.value === 'object' && cell.value.result != null) {
    const q = parseQuantity(cell.value.result);
    if (q > 0) return q;
  }
  if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
    return parseQuantity(cell.value);
  }
  const fromValue = parseQuantity(normalizeCellValue(cell));
  if (fromValue > 0) return fromValue;
  if (cell.text != null && String(cell.text).trim() !== '') {
    return parseQuantity(cell.text);
  }
  return 0;
}

/**
 * Строка импорта: A — артикул, B — количество, C — себестоимость (опционально).
 * Без колонки C — как раньше: количество только из B.
 */
function parseImportRowCells(row) {
  let rawArticle = normalizeRawArticle(String(normalizeCellValue(row.getCell(1))).trim());
  if (!rawArticle || isPureQuantityText(rawArticle)) {
    rawArticle = '';
  }

  let qty = parseQuantityFromCell(row.getCell(2));
  const cost = parseCostFromCell(row.getCell(3));
  const maxCol = Math.max(row.cellCount || 0, 6, row.actualCellCount || 0);

  if (!rawArticle) {
    for (let c = 1; c <= maxCol; c++) {
      const rawStr = normalizeRawArticle(String(normalizeCellValue(row.getCell(c))).trim());
      if (rawStr && !isPureQuantityText(rawStr)) {
        rawArticle = rawStr;
        break;
      }
    }
  }

  return { rawArticle, qty, cost };
}

export const PURCHASE_IMPORT_PARSER_VERSION = 'v4-article-qty-cost';

function getWorksheetScanEndRow(worksheet, startRow) {
  const bottom = Math.max(
    worksheet.dimensions?.bottom || 0,
    worksheet.rowCount || 0,
    getWorksheetLastDataRow(worksheet, startRow),
    startRow
  );
  return bottom + 3;
}

/** Собрать все строки Excel (артикул + кол-во). */
function collectPurchaseImportSourceRows(ws, startRow, keyRow, prefixes) {
  const sourceRows = [];
  const endRow = getWorksheetScanEndRow(ws, startRow);
  let lastRawArticle = '';

  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber++) {
    const row = ws.getRow(rowNumber);
    let { rawArticle, qty, cost } = keyRow
      ? articleAndQtyFromHeaderRow(ws, rowNumber, keyRow)
      : parseImportRowCells(row);

    if (!rawArticle && qty > 0 && lastRawArticle) {
      rawArticle = lastRawArticle;
    }
    if (!rawArticle || qty <= 0) continue;

    rawArticle = normalizeRawArticle(rawArticle);
    lastRawArticle = rawArticle;

    const cleanSku = stripSupplierArticlePrefixes(rawArticle, prefixes);
    if (!cleanSku) continue;

    sourceRows.push({ rowNumber, rawArticle, qty, cost: cost ?? null, cleanSku });
  }

  return sourceRows;
}

function mergeImportCost(prev, prevQty, nextCost, nextQty) {
  const pq = Math.max(0, Number(prevQty) || 0);
  const nq = Math.max(0, Number(nextQty) || 0);
  const pc = prev?.purchasePrice;
  const nc = nextCost;
  const hasPrev = pc != null && Number.isFinite(Number(pc)) && pq > 0;
  const hasNext = nc != null && Number.isFinite(Number(nc)) && nq > 0;
  if (!hasPrev && !hasNext) return null;
  if (!hasPrev) return nc;
  if (!hasNext) return pc;
  const totalQty = pq + nq;
  if (totalQty <= 0) return null;
  return Math.round((Number(pc) * pq + Number(nc) * nq) / totalQty * 100) / 100;
}

/** Суммирование дублей только по артикулу из файла (до сопоставления с каталогом). */
function aggregatePurchaseImportSourceRows(sourceRows) {
  const aggregated = new Map();

  for (const sr of sourceRows) {
    const rawNorm = normalizeImportArticleKey(sr.rawArticle);
    const prev = aggregated.get(rawNorm);
    if (prev) {
      const nextQty = prev.quantity + sr.qty;
      prev.purchasePrice = mergeImportCost(prev, prev.quantity, sr.cost, sr.qty);
      prev.quantity = nextQty;
      prev.rawArticles.add(sr.rawArticle);
      prev.cleanSkus.add(sr.cleanSku);
      prev.excelLines.push({ row: sr.rowNumber, qty: sr.qty, cost: sr.cost ?? null });
    } else {
      aggregated.set(rawNorm, {
        quantity: sr.qty,
        purchasePrice: sr.cost ?? null,
        rawArticles: new Set([sr.rawArticle]),
        cleanSkus: new Set([sr.cleanSku]),
        displaySku: sr.cleanSku,
        excelLines: [{ row: sr.rowNumber, qty: sr.qty, cost: sr.cost ?? null }],
      });
    }
  }

  return aggregated;
}

function articleAndQtyFromHeaderRow(worksheet, rowNum, keyRow) {
  const raw = rowToObject(worksheet, rowNum, keyRow);
  const row = worksheet.getRow(rowNum);
  const rawArticle = String(raw.sku || raw.артикул || raw.article || '').trim();
  let qty = parseQuantity(raw.quantity ?? raw.количество ?? raw.qty);
  if (qty <= 0) {
    qty = parseQuantityFromCell(row.getCell(2));
  }
  let cost = parseCost(
    raw.себестоимость ?? raw.себ_сть ?? raw.cost ?? raw.purchase_price ?? raw.цена ?? ''
  );
  if (cost == null) {
    cost = parseCostFromCell(row.getCell(3));
  }
  if (!rawArticle) {
    const fallbackArticle = String(normalizeCellValue(row.getCell(1))).trim();
    const fallbackQty = parseQuantityFromCell(row.getCell(2));
    if (fallbackArticle) {
      return {
        rawArticle: fallbackArticle,
        qty: fallbackQty || qty,
        cost: cost ?? parseCostFromCell(row.getCell(3)),
      };
    }
  }
  return { rawArticle, qty, cost };
}

/** Нормализация списка префиксов: уникальные, без пустых, длинные первыми. */
export function normalizeSupplierPrefixes(input) {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : [input];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const p = String(item ?? '').trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Префиксы из api_config (массив prefixes или устаревшее поле prefix). */
export function supplierPrefixesFromApiConfig(apiConfig) {
  if (!apiConfig || typeof apiConfig !== 'object') return [];
  if (Array.isArray(apiConfig.prefixes)) {
    return normalizeSupplierPrefixes(apiConfig.prefixes);
  }
  const legacy = apiConfig.prefix ?? apiConfig.article_prefix ?? apiConfig.articlePrefix;
  return normalizeSupplierPrefixes(legacy ? [legacy] : []);
}

/** Разделитель между префиксом и артикулом (снимается вместе с префиксом). */
const PREFIX_ARTICLE_SEP = /^[-_./\s]+/;

function trimLeadingPrefixSeparators(article) {
  return String(article || '').replace(PREFIX_ARTICLE_SEP, '');
}

/** Снять один префикс; после него убирается дефис/подчёркивание и т.п. */
function stripOneSupplierPrefix(article, prefix) {
  const p = String(prefix || '').trim();
  if (!p) return null;
  const lower = article.toLowerCase();
  const pl = p.toLowerCase();
  if (!lower.startsWith(pl)) return null;
  let rest = article.slice(p.length);
  rest = trimLeadingPrefixSeparators(rest.trim());
  return rest;
}

/**
 * Снимает с начала артикула все подходящие префиксы поставщика (без учёта регистра).
 * Сначала проверяются более длинные префиксы; цикл — пока что-то снимается.
 * После каждого префикса убирается ведущий дефис (и - _ . /).
 */
export function stripSupplierArticlePrefixes(rawArticle, prefixes) {
  let article = String(rawArticle || '').trim();
  const list = normalizeSupplierPrefixes(prefixes);
  if (!list.length || !article) return article;

  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const p of list) {
      const next = stripOneSupplierPrefix(article, p);
      if (next != null) {
        article = next;
        stripped = true;
        break;
      }
    }
  }
  return trimLeadingPrefixSeparators(article.trim());
}

/** @deprecated используйте stripSupplierArticlePrefixes */
export function stripSupplierArticlePrefix(rawArticle, prefix) {
  return stripSupplierArticlePrefixes(rawArticle, prefix ? [prefix] : []);
}

/** Все варианты артикула для поиска в каталоге (как в файле, после префиксов, альтернативные clean). */
function buildSkuLookupKeys(cleanSku, rawArticles, extraCleanSkus = []) {
  const keys = new Set();
  const add = (s) => {
    const t = String(s ?? '').trim();
    if (t) keys.add(t);
  };
  add(cleanSku);
  for (const r of rawArticles || []) add(r);
  for (const c of extraCleanSkus || []) add(c);
  return [...keys];
}

function collectLookupKeysForAggregatedEntry(data) {
  const keys = new Set();
  const extraClean = data.cleanSkus ? [...data.cleanSkus] : [];
  for (const k of buildSkuLookupKeys(data.displaySku, data.rawArticles, extraClean)) {
    keys.add(k);
  }
  return [...keys];
}

/** Совпадение артикула в каталоге с ключом из Excel (без учёта регистра, суффикс после - _ .). */
export function skuLookupMatchesCatalogSku(lookupKey, catalogSku) {
  const l = String(lookupKey || '').trim().toLowerCase();
  const p = String(catalogSku || '').trim().toLowerCase();
  if (!l || !p) return false;
  if (p === l) return true;
  return p.endsWith(`-${l}`) || p.endsWith(`_${l}`) || p.endsWith(`.${l}`);
}

async function fetchCatalogSkuCandidates(lookupKeysLower, profileId) {
  const pid = profileId != null && profileId !== '' ? Number(profileId) : null;
  const unique = [...new Set(lookupKeysLower.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  if (!unique.length) return [];

  const r = await query(
    `SELECT p.id, TRIM(p.sku) AS sku
     FROM products p
     WHERE ($1::bigint IS NULL OR p.profile_id = $1)
       AND TRIM(COALESCE(p.sku, '')) <> ''
       AND EXISTS (
         SELECT 1 FROM unnest($2::text[]) AS lk(lookup_key)
         WHERE LOWER(TRIM(p.sku)) = lk.lookup_key
            OR LOWER(TRIM(p.sku)) ~ ('(^|[-_.])' || lk.lookup_key || '$')
       )
     UNION
     SELECT p.id, TRIM(ps.sku) AS sku
     FROM product_skus ps
     INNER JOIN products p ON p.id = ps.product_id
     WHERE ($1::bigint IS NULL OR p.profile_id = $1)
       AND TRIM(COALESCE(ps.sku, '')) <> ''
       AND EXISTS (
         SELECT 1 FROM unnest($2::text[]) AS lk(lookup_key)
         WHERE LOWER(TRIM(ps.sku)) = lk.lookup_key
            OR LOWER(TRIM(ps.sku)) ~ ('(^|[-_.])' || lk.lookup_key || '$')
       )`,
    [pid, unique]
  );
  return r.rows || [];
}

function findProductIdForImportEntry(lookupKeys, catalogRows) {
  if (!lookupKeys.length) return null;

  const exactHit = catalogRows.find((row) =>
    lookupKeys.some(
      (k) => String(row.sku || '').trim().toLowerCase() === String(k).trim().toLowerCase()
    )
  );
  if (exactHit?.id != null) return Number(exactHit.id);

  const looseHit = catalogRows.find((row) =>
    lookupKeys.some((k) => skuLookupMatchesCatalogSku(k, row.sku))
  );
  return looseHit?.id != null ? Number(looseHit.id) : null;
}

/**
 * @param {Map<string, object>} aggregated — ключ: normalizeImportArticleKey(raw из файла)
 * @returns {Map<string, number>} rawNorm → productId
 */
async function resolveProductIdsForImport(aggregated, profileId) {
  const allLookups = [];
  for (const data of aggregated.values()) {
    allLookups.push(...collectLookupKeysForAggregatedEntry(data));
  }
  const catalogRows = await fetchCatalogSkuCandidates(
    allLookups.map((k) => k.toLowerCase()),
    profileId
  );

  const map = new Map();
  for (const [rawNorm, data] of aggregated) {
    const keys = collectLookupKeysForAggregatedEntry(data);
    const productId = findProductIdForImportEntry(keys, catalogRows);
    if (productId != null) map.set(rawNorm, productId);
  }
  return map;
}

class PurchasesImportService {
  /** Разбор листа без БД (тесты, отладка суммирования). */
  async parseWorksheetOnly(buffer, prefixes = []) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return { sourceRows: [], preview: [], parserVersion: PURCHASE_IMPORT_PARSER_VERSION };
    const keyRow = findHeaderRow(ws);
    const startRow = keyRow ? keyRow.number + 1 : 1;
    const sourceRows = collectPurchaseImportSourceRows(ws, startRow, keyRow, prefixes);
    const aggregated = aggregatePurchaseImportSourceRows(sourceRows);
    const preview = [...aggregated.values()].map((data) => ({
      cleanSku: data.displaySku,
      quantity: data.quantity,
      purchasePrice: data.purchasePrice ?? null,
      excelLines: data.excelLines,
    }));
    return { sourceRows, preview, parserVersion: PURCHASE_IMPORT_PARSER_VERSION };
  }

  /**
   * Разбор Excel и подготовка позиций закупки.
   * @throws {Error} statusCode 400 если есть нераспознанные артикулы (err.details.unresolved)
   */
  async parseExcelBuffer(buffer, { profileId, supplierId, allowUnresolved = false } = {}) {
    const sid = supplierId != null && supplierId !== '' ? Number(supplierId) : null;
    if (!Number.isFinite(sid) || sid < 1) {
      const err = new Error('Выберите поставщика');
      err.statusCode = 400;
      throw err;
    }

    const supplier = await suppliersService.getById(sid, { profileId });
    const prefixes = supplierPrefixesFromApiConfig(supplier.apiConfig || supplier.api_config);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) {
      const err = new Error('Файл Excel пуст');
      err.statusCode = 400;
      throw err;
    }

    const keyRow = findHeaderRow(ws);
    const startRow = keyRow ? keyRow.number + 1 : 1;
    const sourceRows = collectPurchaseImportSourceRows(ws, startRow, keyRow, prefixes);
    const aggregated = aggregatePurchaseImportSourceRows(sourceRows);

    if (aggregated.size === 0) {
      const err = new Error(
        'В файле нет строк с артикулом и количеством. Ожидается: A — артикул, B — количество, C — цена (опционально), либо колонки «артикул», «количество», «цена» / «себестоимость».'
      );
      err.statusCode = 400;
      throw err;
    }

    const productMap = await resolveProductIdsForImport(aggregated, profileId);

    const itemsByProduct = new Map();
    const unresolved = [];

    for (const [rawNorm, data] of aggregated) {
      const cleanSku = data.displaySku || [...data.rawArticles][0] || '';
      const productId = productMap.get(rawNorm);
      const row = {
        cleanSku,
        quantity: data.quantity,
        rawArticles: [...data.rawArticles],
        excelLines: data.excelLines || [],
      };
      if (productId) {
        const prev = itemsByProduct.get(productId);
        if (prev) {
          const oldQty = prev.quantity;
          prev.purchasePrice = mergeImportCost(prev, oldQty, data.purchasePrice, data.quantity);
          prev.quantity = oldQty + data.quantity;
        } else {
          itemsByProduct.set(productId, {
            quantity: data.quantity,
            purchasePrice: data.purchasePrice ?? null,
          });
        }
      } else {
        unresolved.push(row);
      }
    }

    const items = [...itemsByProduct.entries()].map(([productId, row]) => ({
      productId,
      quantity: row.quantity,
      purchasePrice: row.purchasePrice ?? null,
    }));

    if (unresolved.length > 0 && !allowUnresolved) {
      const lines = unresolved
        .slice(0, 30)
        .map((u) => `${u.cleanSku} (${u.quantity} шт.)`)
        .join(', ');
      const tail = unresolved.length > 30 ? ` и ещё ${unresolved.length - 30}` : '';
      const err = new Error(
        `Не найдены товары в каталоге (${unresolved.length}): ${lines}${tail}. Закупка не создана.`
      );
      err.statusCode = 400;
      err.details = { unresolved, prefixes, items };
      throw err;
    }

    const preview = [...aggregated.values()].map((data) => ({
      cleanSku: data.displaySku,
      quantity: data.quantity,
      purchasePrice: data.purchasePrice ?? null,
      rawArticles: [...data.rawArticles],
      excelLines: data.excelLines || [],
    }));

    const hasImportPrices = items.some((it) => it.purchasePrice != null);

    return {
      items,
      preview,
      prefixes,
      sourceRows,
      unresolved,
      hasImportPrices,
      parserVersion: PURCHASE_IMPORT_PARSER_VERSION,
      lineCount: items.length,
      excelDataRows: sourceRows.length,
      totalQuantity: items.reduce((s, it) => s + it.quantity, 0),
    };
  }

  /** Разбор Excel для заполнения таблицы закупки (без создания документа). */
  async previewExcelBuffer(buffer, { profileId, supplierId } = {}) {
    const parsed = await this.parseExcelBuffer(buffer, {
      profileId,
      supplierId,
      allowUnresolved: true,
    });
    const ids = parsed.items.map((it) => it.productId).filter(Boolean);
    let productsById = new Map();
    if (ids.length > 0) {
      const r = await query(
        `SELECT id, sku, name FROM products WHERE id = ANY($1::bigint[])`,
        [ids]
      );
      productsById = new Map((r.rows || []).map((row) => [String(row.id), row]));
    }
    const tableItems = parsed.items.map((it) => {
      const p = productsById.get(String(it.productId));
      return {
        ...it,
        sku: p?.sku || null,
        name: p?.name || null,
      };
    });
    return { ...parsed, tableItems };
  }

  /**
   * Импорт Excel и создание закупки (только если все артикулы найдены).
   */
  async importExcelAndCreate(
    buffer,
    { supplierId, organizationId, warehouseId, note = null, profileId, userId } = {}
  ) {
    const parsed = await this.parseExcelBuffer(buffer, { profileId, supplierId });
    const created = await purchasesService.create(
      {
        supplierId,
        organizationId,
        warehouseId,
        items: parsed.items,
        note,
      },
      { userId, profileId }
    );
    let costsUpdated = 0;
    if (parsed.hasImportPrices) {
      const costResult = await purchasesService.applyProductCostsFromImport(parsed.items, { profileId });
      costsUpdated = costResult?.costsUpdated ?? 0;
    }
    return { ...created, importSummary: { ...parsed, costsUpdated } };
  }
}

export default new PurchasesImportService();
