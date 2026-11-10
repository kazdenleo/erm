/**
 * Импорт пачки парсера в ERP: ZIP с .xlsx + папки артикулов с фото.
 * Доступен только при product_enrichment_enabled (раздел «Обогащение»).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { isProfileProductEnrichmentEnabled } from '../utils/profileProductEnrichment.js';
import { saveLocalImageBufferToProductFolder } from './productImagesImport.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_ROOT = path.resolve(__dirname, '../../uploads/tmp/catalog-import');
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CREATE = 5000;
const MAX_IMAGES = 50;
const MAX_PREVIEW_ROWS = 5000;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const SKIP_COLUMNS = new Set([
  'url',
  'folder',
  'артикул_папка',
  'image_files',
  'folder_name',
]);

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function profilesRepo() {
  return repositoryFactory.getProfilesRepository();
}

function productsRepo() {
  return repositoryFactory.getProductsRepository();
}

async function ensureEnrichmentAllowed(profileId) {
  if (profileId == null) {
    const err = new Error('Импорт доступен только в контексте аккаунта');
    err.statusCode = 403;
    throw err;
  }
  const profile = await profilesRepo().findById(profileId);
  if (!isProfileProductEnrichmentEnabled(profile)) {
    const err = new Error('Модуль обогащения выключен в настройках аккаунта');
    err.statusCode = 403;
    throw err;
  }
  return profile;
}

function normKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function skuKey(s) {
  return String(s || '')
    .trim()
    .toUpperCase();
}

function cellText(cell) {
  if (cell == null) return '';
  const v = cell.value != null ? cell.value : cell;
  if (v == null) return '';
  if (typeof v === 'number' && !Number.isNaN(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v.trim();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.text != null) return String(v.text).trim();
    if (v.result != null) return cellText({ value: v.result });
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((p) => p?.text || '')
        .join('')
        .trim();
    }
    if (v.hyperlink != null && v.text != null) return String(v.text).trim();
  }
  return String(v).trim();
}

function pickColumnByHints(columns, hints, { exactFirst = true } = {}) {
  const list = Array.isArray(columns) ? columns : [];
  if (exactFirst) {
    for (const col of list) {
      const n = normKey(col);
      if (hints.some((h) => n === h)) return col;
    }
  }
  for (const col of list) {
    const n = normKey(col);
    if (hints.some((h) => n === h || n.includes(h))) return col;
  }
  return '';
}

function suggestMapping(columns) {
  return {
    sku: pickColumnByHints(columns, ['артикул', 'sku', 'article', 'арт']),
    name: pickColumnByHints(columns, ['название', 'name', 'title', 'наименование']),
    brand: pickColumnByHints(columns, ['бренд', 'brand', 'марка']),
    description: pickColumnByHints(columns, ['описание', 'description', 'desc']),
    country: pickColumnByHints(columns, [
      'страна производителя',
      'страна производства',
      'страна',
      'country',
      'country of origin',
    ]),
    applicability: pickColumnByHints(columns, ['применимость', 'applicability', 'применяемость']),
    analogs: pickColumnByHints(columns, ['аналоги', 'analogs', 'analogues', 'кроссы', 'cross']),
  };
}

function mappedColumnSet(mapping = {}) {
  return new Set(
    ['sku', 'name', 'brand', 'description', 'country', 'applicability', 'analogs']
      .map((k) => normKey(mapping[k]))
      .filter(Boolean)
  );
}

async function loadAttributeCatalog() {
  try {
    const result = await query(
      `SELECT id, name, system_key
       FROM product_attributes
       ORDER BY name`
    );
    return (result.rows || []).map((r) => ({
      id: String(r.id),
      name: String(r.name || ''),
      systemKey: r.system_key != null ? String(r.system_key) : null,
    }));
  } catch {
    return [];
  }
}

function suggestAttributeMappings(columns, attributes) {
  const out = {};
  const cols = Array.isArray(columns) ? columns : [];
  for (const attr of attributes || []) {
    if (attr.systemKey) continue; // системные поля карточки маппим отдельно
    const want = normKey(attr.name);
    if (!want) continue;
    const hit = cols.find((c) => normKey(c) === want);
    if (hit) out[String(attr.id)] = hit;
  }
  return out;
}

async function ensureCategoryHasAttributes(categoryId, attrIds) {
  const cid = categoryId != null && categoryId !== '' ? Number(categoryId) : NaN;
  if (!Number.isFinite(cid)) return;
  for (const attrId of attrIds || []) {
    const aid = attrId != null && attrId !== '' ? Number(attrId) : NaN;
    if (!Number.isFinite(aid)) continue;
    try {
      await query(
        `INSERT INTO category_attributes (user_category_id, attribute_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [cid, aid]
      );
    } catch {
      /* ignore */
    }
  }
}

function shouldSkipColumn(name) {
  const key = String(name || '').trim();
  if (!key || key.startsWith('_')) return true;
  const low = key.toLowerCase();
  if (SKIP_COLUMNS.has(key) || SKIP_COLUMNS.has(low)) return true;
  if (low.endsWith('_files')) return true;
  if (/^\d+\s*фото:/i.test(key)) return true;
  return false;
}

function looksLikePhotoSummary(text) {
  return /^\d+\s*фото:/i.test(String(text || '').trim());
}

function zipPathParts(entryName) {
  return String(entryName || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
}

function detectCommonRoot(paths) {
  if (!paths.length) return [];
  const split = paths.map(zipPathParts);
  const first = split[0];
  if (!first.length) return [];
  let depth = 0;
  while (depth < first.length - 1) {
    const seg = first[depth];
    if (!seg || seg.toLowerCase().endsWith('.xlsx')) break;
    if (!split.every((p) => p[depth] === seg)) break;
    // Only strip if every path has more after this segment (folder root wrapper)
    if (!split.every((p) => p.length > depth + 1)) break;
    depth += 1;
  }
  return first.slice(0, depth);
}

function sessionDir(sessionId) {
  return path.join(SESSION_ROOT, String(sessionId));
}

function metaPath(sessionId) {
  return path.join(sessionDir(sessionId), 'meta.json');
}

function readMeta(sessionId) {
  const p = metaPath(sessionId);
  if (!fs.existsSync(p)) {
    const err = new Error('Сессия импорта не найдена или устарела. Загрузите ZIP снова.');
    err.statusCode = 404;
    throw err;
  }
  const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (meta?.expiresAt && Date.now() > Number(meta.expiresAt)) {
    removeSession(sessionId);
    const err = new Error('Сессия импорта истекла. Загрузите ZIP снова.');
    err.statusCode = 410;
    throw err;
  }
  return meta;
}

function writeMeta(sessionId, meta) {
  ensureDirSync(sessionDir(sessionId));
  fs.writeFileSync(metaPath(sessionId), JSON.stringify(meta, null, 2), 'utf8');
}

function removeSession(sessionId) {
  const dir = sessionDir(sessionId);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

export function cleanupExpiredCatalogImportSessions() {
  ensureDirSync(SESSION_ROOT);
  let removed = 0;
  for (const name of fs.readdirSync(SESSION_ROOT)) {
    const dir = path.join(SESSION_ROOT, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const mp = path.join(dir, 'meta.json');
      if (!fs.existsSync(mp)) {
        const age = Date.now() - fs.statSync(dir).mtimeMs;
        if (age > SESSION_TTL_MS) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
        continue;
      }
      const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (meta?.expiresAt && Date.now() > Number(meta.expiresAt)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

async function parseWorkbookBuffer(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Data') || wb.worksheets[0];
  if (!ws) {
    const err = new Error('В Excel нет листа с данными');
    err.statusCode = 400;
    throw err;
  }

  let maxCol = 0;
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
    if (cell.col > maxCol) maxCol = cell.col;
  });
  if (maxCol < 1) {
    const err = new Error('В Excel пустая первая строка (заголовки)');
    err.statusCode = 400;
    throw err;
  }

  const columns = [];
  for (let c = 1; c <= maxCol; c++) {
    const h = cellText(ws.getRow(1).getCell(c));
    columns.push(h || `col_${c}`);
  }

  const rows = [];
  const maxRow = Math.min(ws.rowCount || 0, MAX_PREVIEW_ROWS + 2);
  let emptyStreak = 0;
  for (let r = 2; r <= maxRow; r++) {
    const excelRow = ws.getRow(r);
    const obj = {};
    let any = false;
    for (let c = 1; c <= maxCol; c++) {
      const key = columns[c - 1];
      const val = cellText(excelRow.getCell(c));
      if (val) any = true;
      if (!shouldSkipColumn(key)) obj[key] = val;
    }
    if (!any) {
      emptyStreak += 1;
      if (emptyStreak >= 25) break;
      continue;
    }
    emptyStreak = 0;
    rows.push(obj);
  }

  return { columns: columns.filter((c) => !shouldSkipColumn(c)), rows };
}

function listImageFilesInDir(absDir) {
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return [];
  const files = fs
    .readdirSync(absDir)
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      return IMAGE_EXTS.has(ext);
    })
    .sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === a.replace(/\.[^.]+$/, '') && String(nb) === b.replace(/\.[^.]+$/, '')) {
        return na - nb;
      }
      return a.localeCompare(b, 'ru');
    });
  return files.map((name) => path.join(absDir, name));
}

function buildFolderIndex(extractRoot) {
  /** @type {Map<string, string>} skuKey -> abs folder path */
  const map = new Map();
  if (!fs.existsSync(extractRoot)) return map;
  for (const name of fs.readdirSync(extractRoot)) {
    const abs = path.join(extractRoot, name);
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    map.set(skuKey(name), abs);
  }
  return map;
}

function resolveMappedValue(row, columnName) {
  if (!columnName) return '';
  const v = row?.[columnName];
  if (v == null) return '';
  const s = String(v).trim();
  if (looksLikePhotoSummary(s)) return '';
  return s;
}

/** Одна колонка или список колонок → массив имён */
function normalizeMappedColumns(colSpec) {
  if (Array.isArray(colSpec)) {
    return colSpec.map((c) => String(c || '').trim()).filter(Boolean);
  }
  if (colSpec == null || colSpec === '') return [];
  return [String(colSpec).trim()].filter(Boolean);
}

/** Значения из нескольких столбцов через точку (пустые пропускаем) */
function resolveMappedColumnsValue(row, colSpec, joiner = '.') {
  const parts = [];
  for (const col of normalizeMappedColumns(colSpec)) {
    const v = resolveMappedValue(row, col);
    if (v) parts.push(v);
  }
  return parts.join(joiner);
}

function buildDescription(row, mapping, columns, extraUsedCols = []) {
  const used = mappedColumnSet(mapping);
  for (const c of extraUsedCols || []) {
    const n = normKey(c);
    if (n) used.add(n);
  }
  const parts = [];
  for (const col of columns) {
    if (used.has(normKey(col))) continue;
    const val = resolveMappedValue(row, col);
    if (!val) continue;
    parts.push(`${col}: ${val}`);
  }
  return parts.join('\n').slice(0, 8000);
}

/**
 * @param {Buffer} zipBuffer
 * @param {{ profileId: number|string }} opts
 */
export async function uploadAndPreview(zipBuffer, opts = {}) {
  cleanupExpiredCatalogImportSessions();
  await ensureEnrichmentAllowed(opts.profileId);

  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    const err = new Error('Нужен ZIP-архив');
    err.statusCode = 400;
    throw err;
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    const err = new Error('Не удалось прочитать ZIP');
    err.statusCode = 400;
    throw err;
  }

  const fileEntries = Object.keys(zip.files).filter((k) => !zip.files[k].dir);
  if (!fileEntries.length) {
    const err = new Error('ZIP пустой');
    err.statusCode = 400;
    throw err;
  }

  const rootPrefix = detectCommonRoot(fileEntries);
  const stripRoot = (parts) => (rootPrefix.length ? parts.slice(rootPrefix.length) : parts);

  const xlsxKeys = fileEntries.filter((k) => {
    const parts = stripRoot(zipPathParts(k));
    return parts.length === 1 && parts[0].toLowerCase().endsWith('.xlsx');
  });
  if (!xlsxKeys.length) {
    const err = new Error('В архиве нет .xlsx в корне (рядом с папками артикулов)');
    err.statusCode = 400;
    throw err;
  }
  xlsxKeys.sort();
  const xlsxKey = xlsxKeys[0];
  const xlsxBuf = Buffer.from(await zip.files[xlsxKey].async('uint8array'));
  const { columns, rows: rawRows } = await parseWorkbookBuffer(xlsxBuf);
  if (!rawRows.length) {
    const err = new Error('В Excel нет строк с данными');
    err.statusCode = 400;
    throw err;
  }

  const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const root = sessionDir(sessionId);
  const extractRoot = path.join(root, 'files');
  ensureDirSync(extractRoot);

  // Write xlsx
  fs.writeFileSync(path.join(extractRoot, path.basename(zipPathParts(xlsxKey).pop())), xlsxBuf);

  // Extract image folders / files
  for (const key of fileEntries) {
    if (key === xlsxKey) continue;
    const parts = stripRoot(zipPathParts(key));
    if (!parts.length) continue;
    const abs = path.join(extractRoot, ...parts);
    if (parts[parts.length - 1].includes('\0') || abs.includes('..')) continue;
    ensureDirSync(path.dirname(abs));
    const data = Buffer.from(await zip.files[key].async('uint8array'));
    fs.writeFileSync(abs, data);
  }

  return finalizePreviewSession({
    sessionId,
    profileId: opts.profileId,
    extractRoot,
    columns,
    rawRows,
  });
}

/**
 * Превью из уже выбранной папки: список файлов на диске + относительные пути.
 * @param {Array<{ path: string, relativePath: string }>} diskFiles
 * @param {{ profileId: number|string }} opts
 */
export async function uploadAndPreviewFromFolderFiles(diskFiles, opts = {}) {
  cleanupExpiredCatalogImportSessions();
  await ensureEnrichmentAllowed(opts.profileId);

  const list = Array.isArray(diskFiles) ? diskFiles : [];
  if (!list.length) {
    const err = new Error('Папка пустая');
    err.statusCode = 400;
    throw err;
  }

  const relPaths = list.map((f) =>
    String(f.relativePath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
  );
  const rootPrefix = detectCommonRoot(relPaths.filter(Boolean));
  const stripRoot = (parts) => (rootPrefix.length ? parts.slice(rootPrefix.length) : parts);

  const xlsxIdx = [];
  for (let i = 0; i < list.length; i++) {
    const parts = stripRoot(zipPathParts(relPaths[i]));
    if (parts.length === 1 && parts[0].toLowerCase().endsWith('.xlsx')) {
      xlsxIdx.push(i);
    }
  }
  if (!xlsxIdx.length) {
    const err = new Error(
      'В папке нет .xlsx в корне (рядом с папками артикулов). Выберите папку, где лежит Excel и подпапки с фото.'
    );
    err.statusCode = 400;
    throw err;
  }
  xlsxIdx.sort((a, b) => relPaths[a].localeCompare(relPaths[b], 'ru'));
  const xlsxFile = list[xlsxIdx[0]];
  const xlsxBuf = fs.readFileSync(xlsxFile.path);
  const { columns, rows: rawRows } = await parseWorkbookBuffer(xlsxBuf);
  if (!rawRows.length) {
    const err = new Error('В Excel нет строк с данными');
    err.statusCode = 400;
    throw err;
  }

  const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const extractRoot = path.join(sessionDir(sessionId), 'files');
  ensureDirSync(extractRoot);

  for (let i = 0; i < list.length; i++) {
    const parts = stripRoot(zipPathParts(relPaths[i]));
    if (!parts.length) continue;
    if (parts.some((p) => p === '..' || p.includes('\0'))) continue;
    const abs = path.join(extractRoot, ...parts);
    ensureDirSync(path.dirname(abs));
    try {
      fs.copyFileSync(list[i].path, abs);
    } catch {
      try {
        fs.renameSync(list[i].path, abs);
      } catch (e) {
        const err = new Error(`Не удалось сохранить файл: ${relPaths[i]}`);
        err.statusCode = 400;
        throw err;
      }
    }
  }

  // подчистить temp multer-файлы, если остались
  for (const f of list) {
    try {
      if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
    } catch {
      /* ignore */
    }
  }

  return finalizePreviewSession({
    sessionId,
    profileId: opts.profileId,
    extractRoot,
    columns,
    rawRows,
  });
}

async function finalizePreviewSession({ sessionId, profileId, extractRoot, columns, rawRows }) {
  const folderIndex = buildFolderIndex(extractRoot);
  const suggestedMapping = suggestMapping(columns);
  const attributes = await loadAttributeCatalog();
  const suggestedAttributeMappings = suggestAttributeMappings(columns, attributes);

  const previewRows = rawRows.slice(0, MAX_PREVIEW_ROWS).map((row, index) => {
    const skuGuess =
      resolveMappedValue(row, suggestedMapping.sku) ||
      Object.values(row).find((v) => v && folderIndex.has(skuKey(v))) ||
      '';
    const sku = String(skuGuess || '').trim();
    const folder = sku ? folderIndex.get(skuKey(sku)) : null;
    const imagePaths = folder
      ? listImageFilesInDir(folder).map((p) => path.relative(extractRoot, p))
      : [];
    const warnings = [];
    if (!sku) warnings.push('Нет артикула');
    if (sku && !folder) warnings.push('Нет папки с фото');
    else if (sku && folder && imagePaths.length === 0) warnings.push('Папка без изображений');
    const name = resolveMappedValue(row, suggestedMapping.name);
    if (!name && !sku) warnings.push('Нет названия');
    return {
      index: index + 1,
      sku,
      name: name || sku,
      brand: resolveMappedValue(row, suggestedMapping.brand),
      imageCount: imagePaths.length,
      imagePaths,
      warnings,
      raw: row,
    };
  });

  const meta = {
    sessionId,
    profileId: Number(profileId),
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    columns,
    suggestedMapping,
    suggestedAttributeMappings,
    attributes,
    extractRel: 'files',
    rows: previewRows,
  };
  writeMeta(sessionId, meta);

  return {
    sessionId,
    columns,
    suggestedMapping,
    suggestedAttributeMappings,
    attributes: attributes.map((a) => ({
      id: a.id,
      name: a.name,
      systemKey: a.systemKey,
    })),
    totalRows: previewRows.length,
    rows: previewRows.map(({ raw, imagePaths, ...rest }) => ({
      ...rest,
      imagePaths,
    })),
  };
}

/**
 * @param {{
 *   sessionId: string,
 *   profileId: number|string,
 *   mapping?: { sku?: string, name?: string, brand?: string },
 *   defaults?: { categoryId?: any, organizationId?: any, brandId?: any, brand?: string },
 *   selectedIndexes?: number[],
 *   selectedSkus?: string[],
 * }} opts
 */
export async function createFromSession(opts = {}) {
  cleanupExpiredCatalogImportSessions();
  await ensureEnrichmentAllowed(opts.profileId);

  const sessionId = String(opts.sessionId || '').trim();
  if (!sessionId) {
    const err = new Error('Нужен sessionId');
    err.statusCode = 400;
    throw err;
  }

  const meta = readMeta(sessionId);
  if (Number(meta.profileId) !== Number(opts.profileId)) {
    const err = new Error('Сессия принадлежит другому аккаунту');
    err.statusCode = 403;
    throw err;
  }

  const baseMap = meta.suggestedMapping || {};
  const mapping = {
    sku: opts.mapping?.sku || baseMap.sku || '',
    name: opts.mapping?.name || baseMap.name || '',
    brand: opts.mapping?.brand || baseMap.brand || '',
    description: opts.mapping?.description || baseMap.description || '',
    country: opts.mapping?.country || baseMap.country || '',
    applicability: opts.mapping?.applicability || baseMap.applicability || '',
    analogs: opts.mapping?.analogs || baseMap.analogs || '',
  };
  const attributeMappings =
    opts.attributeMappings && typeof opts.attributeMappings === 'object'
      ? opts.attributeMappings
      : meta.suggestedAttributeMappings || {};
  const defaults = opts.defaults || {};
  const categoryId =
    defaults.categoryId != null && defaults.categoryId !== '' ? defaults.categoryId : null;
  const organizationId =
    defaults.organizationId != null && defaults.organizationId !== ''
      ? defaults.organizationId
      : null;
  if (categoryId == null || organizationId == null) {
    const err = new Error('Нужны категория и организация');
    err.statusCode = 400;
    throw err;
  }
  const attributes = Array.isArray(meta.attributes)
    ? meta.attributes
    : await loadAttributeCatalog();
  const attrById = new Map(attributes.map((a) => [String(a.id), a]));
  const attrByName = new Map(
    attributes.map((a) => [normKey(a.name), a]).filter(([k]) => k)
  );
  const applicabilityAttr =
    attrByName.get('применимость') || attrByName.get('applicability') || null;
  const analogsAttr = attrByName.get('аналоги') || attrByName.get('analogs') || null;

  const extractRoot = path.join(sessionDir(sessionId), meta.extractRel || 'files');
  const folderIndex = buildFolderIndex(extractRoot);

  let candidates = Array.isArray(meta.rows) ? meta.rows.slice() : [];
  const selectedIndexes = Array.isArray(opts.selectedIndexes)
    ? new Set(opts.selectedIndexes.map((n) => Number(n)))
    : null;
  const selectedSkus = Array.isArray(opts.selectedSkus)
    ? new Set(opts.selectedSkus.map((s) => skuKey(s)).filter(Boolean))
    : null;

  if (selectedIndexes && selectedIndexes.size) {
    candidates = candidates.filter((r) => selectedIndexes.has(Number(r.index)));
  } else if (selectedSkus && selectedSkus.size) {
    candidates = candidates.filter((r) => selectedSkus.has(skuKey(r.sku)));
  }

  if (!candidates.length) {
    const err = new Error('Нет выбранных позиций');
    err.statusCode = 400;
    throw err;
  }
  if (candidates.length > MAX_CREATE) {
    const err = new Error(`За один раз не больше ${MAX_CREATE} товаров`);
    err.statusCode = 400;
    throw err;
  }

  const productsService = (await import('./products.service.js')).default;
  const results = [];

  for (const item of candidates) {
    const raw = item.raw || {};
    const sku =
      resolveMappedValue(raw, mapping.sku) ||
      String(item.sku || '').trim();
    const name =
      resolveMappedValue(raw, mapping.name) ||
      String(item.name || '').trim() ||
      sku;
    const brandName =
      resolveMappedValue(raw, mapping.brand) ||
      String(defaults.brand || item.brand || '').trim();
    const row = { index: item.index, sku, name, brand: brandName, ok: false };

    if (!sku) {
      row.error = 'Нет артикула';
      results.push(row);
      continue;
    }
    if (!name) {
      row.error = 'Нет названия';
      results.push(row);
      continue;
    }

    try {
      const existing = await productsService.getBySku(sku, { profileId: opts.profileId });
      if (existing) {
        row.ok = false;
        row.skipped = true;
        row.productId = existing.id;
        row.error = 'Товар с таким артикулом уже существует';
        results.push(row);
        continue;
      }

      const attrColsUsed = Object.values(attributeMappings || {}).flatMap((spec) =>
        normalizeMappedColumns(spec)
      );
      const mappedDescription = resolveMappedValue(raw, mapping.description);
      const description =
        mappedDescription ||
        buildDescription(raw, mapping, meta.columns || [], attrColsUsed) ||
        null;
      const countryFromCol = resolveMappedValue(raw, mapping.country);
      const countryDefault = String(defaults.countryOfOrigin || defaults.country_of_origin || '').trim();
      const countryOfOrigin = countryFromCol || countryDefault || null;

      const attributeValues = {};
      const attrsToAttach = [];

      const applicabilityText = resolveMappedValue(raw, mapping.applicability);
      if (applicabilityText && applicabilityAttr?.id) {
        attributeValues[String(applicabilityAttr.id)] = applicabilityText;
        attrsToAttach.push(applicabilityAttr.id);
      }
      const analogsText = resolveMappedValue(raw, mapping.analogs);
      if (analogsText && analogsAttr?.id) {
        attributeValues[String(analogsAttr.id)] = analogsText;
        attrsToAttach.push(analogsAttr.id);
      }

      for (const [attrId, colSpec] of Object.entries(attributeMappings || {})) {
        const aid = String(attrId || '').trim();
        const cols = normalizeMappedColumns(colSpec);
        if (!aid || !cols.length) continue;
        // Не дублируем, если уже записали через спец-поля
        if (
          (applicabilityAttr && aid === String(applicabilityAttr.id) && mapping.applicability) ||
          (analogsAttr && aid === String(analogsAttr.id) && mapping.analogs)
        ) {
          continue;
        }
        const attr = attrById.get(aid);
        if (!attr || attr.systemKey) continue;
        const val = resolveMappedColumnsValue(raw, cols, '.');
        if (!val) continue;
        attributeValues[aid] = val;
        attrsToAttach.push(aid);
      }

      if (attrsToAttach.length) {
        await ensureCategoryHasAttributes(categoryId, attrsToAttach);
      }

      const payload = {
        profileId: opts.profileId,
        name,
        sku,
        brand: brandName || undefined,
        brand_id:
          defaults.brandId != null && defaults.brandId !== ''
            ? Number(defaults.brandId)
            : undefined,
        categoryId,
        organizationId,
        description,
        country_of_origin: countryOfOrigin,
      };
      if (payload.brand_id != null && !Number.isFinite(payload.brand_id)) {
        delete payload.brand_id;
      }
      if (Object.keys(attributeValues).length) {
        payload.attribute_values = attributeValues;
      }

      const product = await productsService.create(payload);
      const productId = product?.id;
      let imagesAdded = 0;

      const folder = folderIndex.get(skuKey(sku));
      const imageFiles = folder ? listImageFilesInDir(folder).slice(0, MAX_IMAGES) : [];
      if (productId != null && imageFiles.length) {
        const downloaded = [];
        const seenHashes = new Set();
        for (let i = 0; i < imageFiles.length; i++) {
          try {
            const buf = fs.readFileSync(imageFiles[i]);
            const rec = await saveLocalImageBufferToProductFolder(productId, buf, {
              filename: path.basename(imageFiles[i]),
              primary: downloaded.length === 0,
              marketplaces: { ozon: true, wb: true, ym: true },
            });
            if (!rec) continue;
            const hash = String(rec.content_hash || '').toLowerCase();
            if (hash && seenHashes.has(hash)) continue;
            if (hash) seenHashes.add(hash);
            downloaded.push(rec);
          } catch (imgErr) {
            row.imageWarning = row.imageWarning
              ? `${row.imageWarning}; ${imgErr?.message || imgErr}`
              : String(imgErr?.message || imgErr);
          }
        }
        if (downloaded.length) {
          downloaded.forEach((d, i) => {
            d.primary = i === 0;
          });
          await productsRepo().update(productId, { images: downloaded });
          imagesAdded = downloaded.length;
        }
      }

      row.ok = true;
      row.productId = productId;
      row.imagesAdded = imagesAdded;
    } catch (err) {
      row.error = err?.message || String(err);
      row.statusCode = err?.statusCode || null;
    }
    results.push(row);
  }

  removeSession(sessionId);

  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    results,
  };
}

export default {
  uploadAndPreview,
  uploadAndPreviewFromFolderFiles,
  createFromSession,
  cleanupExpiredCatalogImportSessions,
};
