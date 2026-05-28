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
  if (v == null) return '';
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

function rowToObject(worksheet, rowNum, keyRow) {
  const row = worksheet.getRow(rowNum);
  const obj = {};
  keyRow.eachCell({ includeEmpty: true }, (cell, col) => {
    const key = normalizeCellValue(cell).toLowerCase().replace(/\s+/g, '_');
    if (!key) return;
    obj[key] = normalizeCellValue(row.getCell(col));
  });
  return obj;
}

function findKeyRow(worksheet) {
  for (let r = 1; r <= Math.min(5, worksheet.rowCount || 5); r++) {
    const row = worksheet.getRow(r);
    const vals = [];
    row.eachCell({ includeEmpty: false }, (c) => vals.push(normalizeCellValue(c).toLowerCase()));
    const joined = vals.join('|');
    if (joined.includes('артикул') || joined.includes('sku') || joined.includes('количество') || joined.includes('quantity')) {
      return row;
    }
  }
  return worksheet.getRow(1);
}

/**
 * Убирает префикс поставщика с начала артикула (без учёта регистра).
 */
export function stripSupplierArticlePrefix(rawArticle, prefix) {
  const article = String(rawArticle || '').trim();
  const p = String(prefix || '').trim();
  if (!p || !article) return article;
  if (article.toLowerCase().startsWith(p.toLowerCase())) {
    return article.slice(p.length).trim();
  }
  return article;
}

function supplierPrefixFromApiConfig(apiConfig) {
  if (!apiConfig || typeof apiConfig !== 'object') return '';
  const p = apiConfig.prefix ?? apiConfig.article_prefix ?? apiConfig.articlePrefix ?? '';
  return String(p).trim();
}

async function resolveProductIdsBySkus(skus, profileId) {
  const pid = profileId != null && profileId !== '' ? Number(profileId) : null;
  const unique = [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;

  const r = await query(
    `SELECT p.id, TRIM(p.sku) AS sku
     FROM products p
     WHERE ($1::bigint IS NULL OR p.profile_id = $1)
       AND TRIM(p.sku) = ANY($2::text[])
     UNION
     SELECT p.id, TRIM(ps.sku) AS sku
     FROM product_skus ps
     INNER JOIN products p ON p.id = ps.product_id
     WHERE ($1::bigint IS NULL OR p.profile_id = $1)
       AND TRIM(ps.sku) = ANY($2::text[])`,
    [pid, unique]
  );
  for (const row of r.rows || []) {
    const sku = row.sku != null ? String(row.sku).trim() : '';
    if (sku && row.id != null && !map.has(sku)) {
      map.set(sku, Number(row.id));
    }
  }
  return map;
}

class PurchasesImportService {
  /**
   * Разбор Excel и подготовка позиций закупки.
   * @throws {Error} statusCode 400 если есть нераспознанные артикулы (err.details.unresolved)
   */
  async parseExcelBuffer(buffer, { profileId, supplierId } = {}) {
    const sid = supplierId != null && supplierId !== '' ? Number(supplierId) : null;
    if (!Number.isFinite(sid) || sid < 1) {
      const err = new Error('Выберите поставщика');
      err.statusCode = 400;
      throw err;
    }

    const supplier = await suppliersService.getById(sid, { profileId });
    const prefix = supplierPrefixFromApiConfig(supplier.apiConfig || supplier.api_config);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) {
      const err = new Error('Файл Excel пуст');
      err.statusCode = 400;
      throw err;
    }

    const keyRow = findKeyRow(ws);
    const aggregated = new Map();

    for (let r = keyRow.number + 1; r <= (ws.rowCount || 0); r++) {
      const raw = rowToObject(ws, r, keyRow);
      const rawArticle = String(raw.sku || raw.артикул || raw.article || '').trim();
      const qty = parseInt(raw.quantity || raw.количество || raw.qty || '0', 10);
      if (!rawArticle || !qty || qty <= 0) continue;

      const cleanSku = stripSupplierArticlePrefix(rawArticle, prefix);
      if (!cleanSku) continue;

      const prev = aggregated.get(cleanSku) || { quantity: 0, rawArticles: new Set() };
      prev.quantity += qty;
      prev.rawArticles.add(rawArticle);
      aggregated.set(cleanSku, prev);
    }

    if (aggregated.size === 0) {
      const err = new Error('В файле нет строк с артикулом и количеством');
      err.statusCode = 400;
      throw err;
    }

    const cleanSkus = [...aggregated.keys()];
    const productMap = await resolveProductIdsBySkus(cleanSkus, profileId);

    const items = [];
    const unresolved = [];

    for (const [cleanSku, data] of aggregated) {
      const productId = productMap.get(cleanSku);
      const row = {
        cleanSku,
        quantity: data.quantity,
        rawArticles: [...data.rawArticles],
      };
      if (productId) {
        items.push({
          productId,
          quantity: data.quantity,
          cleanSku,
          rawArticles: row.rawArticles,
        });
      } else {
        unresolved.push(row);
      }
    }

    if (unresolved.length > 0) {
      const lines = unresolved
        .slice(0, 30)
        .map((u) => `${u.cleanSku} (${u.quantity} шт.)`)
        .join(', ');
      const tail = unresolved.length > 30 ? ` и ещё ${unresolved.length - 30}` : '';
      const err = new Error(
        `Не найдены товары в каталоге (${unresolved.length}): ${lines}${tail}. Закупка не создана.`
      );
      err.statusCode = 400;
      err.details = { unresolved, prefix: prefix || null };
      throw err;
    }

    return {
      items: items.map((it) => ({ productId: it.productId, quantity: it.quantity })),
      preview: items,
      prefix: prefix || null,
      lineCount: items.length,
      totalQuantity: items.reduce((s, it) => s + it.quantity, 0),
    };
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
    return { ...created, importSummary: parsed };
  }
}

export default new PurchasesImportService();
