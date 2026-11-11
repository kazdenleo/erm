/**
 * Выгрузка таблицы цен (как на странице «Цены») в Excel.
 */

import ExcelJS from 'exceljs';
import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
import { privateClientMinPrice } from '../utils/marketplaceMinProfit.js';
import { resolveOrganizationTaxProfile } from '../utils/organizationTaxRates.js';
import { parsePricePushSettings } from '../utils/pricePushSettings.js';

const MAX_EXPORT_PRODUCTS = 25000;

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function moneyCell(v) {
  const n = numOrNull(v);
  return n == null ? null : Math.round(n * 100) / 100;
}

function parseCsvList(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(arr.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))];
}

function parseBoolFlag(v, defaultValue = true) {
  if (v === undefined || v === null || v === '') return defaultValue;
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return defaultValue;
}

function mpPack(product, marketplace) {
  return product?.marketplacePrices?.[marketplace] || {};
}

function writeRow(ws, rowIndex, values, { bold = false, fillArgb = null } = {}) {
  const row = ws.getRow(rowIndex);
  values.forEach((val, colIndex) => {
    const cell = row.getCell(colIndex + 1);
    cell.value = val == null || val === '' ? null : val;
    if (bold) cell.font = { bold: true };
    if (fillArgb) {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: fillArgb },
      };
    }
  });
}

async function loadProfileMarkupRules(profileId) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return [];
  try {
    const res = await query('SELECT price_push_settings FROM profiles WHERE id = $1 LIMIT 1', [pid]);
    return parsePricePushSettings(res.rows?.[0]?.price_push_settings).minMarkupRules || [];
  } catch {
    return [];
  }
}

/**
 * @param {object} filters — как у списка товаров на странице Цен
 * @param {{ showFbs?: boolean, showFbo?: boolean, includePrivate?: boolean }} opts
 */
export async function exportPricesTableExcel(filters = {}, opts = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    const err = new Error('Экспорт в Excel доступен только при PostgreSQL');
    err.statusCode = 501;
    throw err;
  }

  const showFbs = parseBoolFlag(opts.showFbs, true);
  const showFbo = parseBoolFlag(opts.showFbo, true);
  const includePrivate = parseBoolFlag(opts.includePrivate, true);

  const productsRepo = repositoryFactory.getProductsRepository();
  const products = await productsRepo.findAll({
    ...filters,
    limit: MAX_EXPORT_PRODUCTS + 1,
    offset: 0,
  });

  if (!Array.isArray(products)) {
    const err = new Error('Не удалось получить список товаров');
    err.statusCode = 500;
    throw err;
  }
  if (products.length > MAX_EXPORT_PRODUCTS) {
    const err = new Error(
      `Слишком много товаров для одного файла (>${MAX_EXPORT_PRODUCTS}). Уточните фильтры.`
    );
    err.statusCode = 400;
    throw err;
  }

  const orgRepo = repositoryFactory.getOrganizationsRepository();
  const orgOpts = {};
  if (filters.profileId != null && filters.profileId !== '') {
    orgOpts.profileId = filters.profileId;
  }
  const organizations = await orgRepo.findAll(orgOpts);
  const orgById = new Map(
    (organizations || []).map((o) => [String(o.id), o])
  );

  const markupRules = await loadProfileMarkupRules(filters.profileId);

  const headers = [
    'Артикул',
    'Товар',
    'Организация',
    'Бренд',
    'Категория',
    'Себестоимость',
    'Доп. расходы',
  ];
  if (includePrivate) headers.push('Частные (мин.)');

  const mpBlocks = [
    { key: 'ozon', label: 'Ozon' },
    { key: 'wb', label: 'WB' },
    { key: 'ym', label: 'Я.Маркет' },
  ];
  for (const mp of mpBlocks) {
    if (showFbs) headers.push(`${mp.label} мин. FBS`);
    if (showFbo) headers.push(`${mp.label} мин. FBO`);
    if (!showFbs && !showFbo) headers.push(`${mp.label} мин.`);
    headers.push(`${mp.label} макс.`);
    headers.push(`${mp.label} после скидки`);
    headers.push(`${mp.label} до скидки`);
    headers.push(`${mp.label} скидка %`);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ERM';
  wb.created = new Date();
  const ws = wb.addWorksheet('Цены', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  writeRow(ws, 1, headers, { bold: true, fillArgb: 'FFE8EEF5' });

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const org = orgById.get(String(p.organization_id ?? p.organizationId ?? '')) || null;
    const taxProfile = resolveOrganizationTaxProfile(org);
    const productForPrivate = markupRules.length
      ? { ...p, profileMinMarkupRules: markupRules }
      : p;
    const privateMin = includePrivate
      ? privateClientMinPrice(productForPrivate, taxProfile)
      : null;

    const cost = moneyCell(p.cost ?? p.price ?? p.base_price);
    const addExp = moneyCell(p.additionalExpenses ?? p.additional_expenses) ?? 0;

    const row = [
      p.sku || '',
      p.name || '',
      org?.name || '',
      p.brand_name || p.brandName || '',
      p.category_name || p.categoryName || '',
      cost,
      addExp || null,
    ];
    if (includePrivate) row.push(privateMin);

    for (const mp of mpBlocks) {
      const cap = mp.key === 'ozon' ? 'Ozon' : mp.key === 'wb' ? 'Wb' : 'Ym';
      const minLegacy = p[`storedMinPrice${cap}`];
      // Как на странице Цен: Ozon/YM legacy ≈ FBS, WB legacy ≈ FBO.
      const minFbs =
        p[`storedMinPrice${cap}Fbs`] ?? (mp.key === 'wb' ? null : minLegacy) ?? null;
      const minFbo =
        p[`storedMinPrice${cap}Fbo`] ?? (mp.key === 'wb' ? minLegacy : null) ?? null;
      const pack = mpPack(p, mp.key);

      if (showFbs) row.push(moneyCell(minFbs));
      if (showFbo) row.push(moneyCell(minFbo));
      if (!showFbs && !showFbo) {
        row.push(moneyCell(mp.key === 'wb' ? minFbo ?? minLegacy : minFbs ?? minLegacy));
      }
      row.push(moneyCell(pack.maxPrice));
      row.push(moneyCell(pack.sellingPrice));
      row.push(moneyCell(pack.priceBeforeDiscount));
      row.push(moneyCell(pack.discountPercent));
    }

    writeRow(ws, i + 2, row);
  }

  headers.forEach((title, idx) => {
    const col = ws.getColumn(idx + 1);
    const t = String(title);
    if (t === 'Товар') col.width = 36;
    else if (t === 'Артикул') col.width = 16;
    else if (t === 'Организация' || t === 'Категория' || t === 'Бренд') col.width = 18;
    else col.width = Math.min(18, Math.max(12, t.length + 2));
  });

  const buffer = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    productCount: products.length,
  };
}

export function buildPricesExportFiltersFromQuery(query = {}, profileId = null) {
  const filters = {};
  if (profileId != null && profileId !== '') filters.profileId = profileId;

  if (query.organizationId != null && String(query.organizationId).trim() !== '') {
    filters.organizationId = String(query.organizationId).trim();
  }
  if (query.brandId != null && String(query.brandId).trim() !== '' && /^\d+$/.test(String(query.brandId).trim())) {
    filters.brandId = String(query.brandId).trim();
  }
  if (query.categoryId != null && String(query.categoryId).trim() !== '') {
    const cat = String(query.categoryId).trim();
    if (cat === '__no_category__' || /^\d+$/.test(cat)) filters.categoryId = cat;
  }
  if (query.productType != null && String(query.productType).trim() !== '') {
    filters.productType = String(query.productType).trim();
  }
  if (query.search != null && String(query.search).trim() !== '') {
    filters.search = String(query.search).trim();
  }
  if (query.includeArchived === 'true' || query.includeArchived === '1') {
    filters.includeArchived = true;
  }
  if (query.archivedOnly === 'true' || query.archivedOnly === '1') {
    filters.archivedOnly = true;
  }
  const unlinked = parseCsvList(query.unlinkedMp);
  if (unlinked.length) filters.unlinkedMp = unlinked;
  const linked = parseCsvList(query.linkedMp);
  if (linked.length) filters.linkedMp = linked;
  if (query.requireAnyMarketplaceLink === 'true' || query.requireAnyMarketplaceLink === '1') {
    filters.requireAnyMarketplaceLink = true;
  }

  return filters;
}

export default {
  exportPricesTableExcel,
  buildPricesExportFiltersFromQuery,
};
