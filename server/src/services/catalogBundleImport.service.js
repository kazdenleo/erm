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
import { productAttributeListFilter } from '../utils/productAttributeTenant.js';
import { isProfileProductEnrichmentEnabled } from '../utils/profileProductEnrichment.js';
import { saveLocalImageBufferToProductFolder } from './productImagesImport.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_ROOT = path.resolve(__dirname, '../../uploads/tmp/catalog-import');
const INCOMING_ROOT = path.resolve(__dirname, '../../uploads/tmp/catalog-import-incoming');
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

/** Марки для разъединения «NISSANALTRA» / «…07NISSAN…» (длинные первыми). */
const UNGLUE_CAR_BRANDS = [
  'MERCEDES-BENZ',
  'MERCEDES BENZ',
  'MERCEDESBENZ',
  'GENERAL MOTORS',
  'GENERALMOTORS',
  'LAND ROVER',
  'LANDROVER',
  'GREAT WALL',
  'GREATWALL',
  'VOLKSWAGEN',
  'MITSUBISHI',
  'SSANGYONG',
  'CHEVROLET',
  'INFINITI',
  'HYUNDAI',
  'CITROEN',
  'CITROËN',
  'RENAULT',
  'PEUGEOT',
  'SUBARU',
  'SUZUKI',
  'TOYOTA',
  'NISSAN',
  'HONDA',
  'MAZDA',
  'SKODA',
  'ŠKODA',
  'VOLVO',
  'LEXUS',
  'CHERY',
  'GEELY',
  'HAVAL',
  'AUDI',
  'FORD',
  'FIAT',
  'OPEL',
  'SEAT',
  'JEEP',
  'LADA',
  'BMW',
  'KIA',
  'VAZ',
  'UAZ',
  'GAZ',
  'VW',
];

const UNGLUE_BRAND_RE = new RegExp(
  `\\b(${UNGLUE_CAR_BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=[A-ZА-ЯЁa-zа-яё0-9(])`,
  'gi'
);

/**
 * Парсер Miles и подобные часто склеивают ячейки без пробелов.
 * Восстанавливаем пробелы; переносы строк не вставляем.
 */
function unglueParserCellText(raw) {
  let s = String(raw ?? '');
  if (!s) return '';

  // Шапка применимости в значение не нужна — вырезаем (в т.ч. дубли).
  s = s.replace(/(?:Марка\s*авто\s*Модель\s*авто\s*Модификация\s*Год\s*выпуска\s*)+/gi, '');
  s = s.replace(/(?:Марка автоМодель автоМодификацияГод выпуска\s*)+/gi, '');

  // «автоМодель», «выпускаNISSAN»
  s = s.replace(/([а-яё])([А-ЯЁ])/g, '$1 $2');
  s = s.replace(/([а-яё])([A-Z])/g, '$1 $2');

  // OEM/кроссы: …025NISSAN272…
  s = s.replace(/([0-9])([A-Z]{3,}\d)/g, '$1 $2');
  s = s.replace(/(\d{2})([A-Z]{3,})/g, '$1 $2');
  s = s.replace(/(время)([A-Z]{3,})/gi, '$1 $2');

  // Марка+модель / марка+код: NISSANALTRA, HONDA08R79, BMW5
  s = s.replace(UNGLUE_BRAND_RE, '$1 ');
  // GENERAL MOTORS937… / MOTORS937…
  s = s.replace(/(MOTORS)(\d)/gi, '$1 $2');

  // л.с1997 → л.с 1997
  s = s.replace(/(л\.?\s*с\.?)(\d{4})/gi, '$1 $2');
  s = s.replace(/:(?=\S)/g, ': ');
  s = s.replace(/\)\[/g, ') [');

  return s.replace(/\s+/g, ' ').trim();
}

/** RichText: не склеивать куски вплотную, если между ними нет пробела/переноса. */
function joinRichTextRuns(runs) {
  let out = '';
  for (const p of runs || []) {
    const t = String(p?.text ?? '');
    if (!t) continue;
    if (!out) {
      out = t;
      continue;
    }
    const leftWs = /\s$/.test(out);
    const rightWs = /^\s/.test(t);
    if (leftWs || rightWs) {
      out += t;
      continue;
    }
    // Граница «слово/цифра|слово/цифра» без пробела — вставляем пробел (типичный блок применимости/OEM).
    if (/[\dA-Za-zА-Яа-яЁё]$/.test(out) && /^[\dA-Za-zА-Яа-яЁё]/.test(t)) {
      out += ` ${t}`;
    } else {
      out += t;
    }
  }
  return unglueParserCellText(out);
}

/** Сырое значение ячейки без разъединения (для оценки качества файла). */
function cellTextRaw(cell) {
  if (cell == null) return '';
  const v = cell.value != null ? cell.value : cell;
  if (v == null) return '';
  if (typeof v === 'number' && !Number.isNaN(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v.trim();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) {
    return v
      .map((item) => cellTextRaw(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) {
      let out = '';
      for (const p of v.richText) {
        const t = String(p?.text ?? '');
        if (!t) continue;
        if (!out) {
          out = t;
          continue;
        }
        if (/\s$/.test(out) || /^\s/.test(t)) out += t;
        else if (/[\dA-Za-zА-Яа-яЁё]$/.test(out) && /^[\dA-Za-zА-Яа-яЁё]/.test(t)) out += ` ${t}`;
        else out += t;
      }
      return out.trim();
    }
    if (v.text != null) return String(v.text).trim();
    if (v.result != null) return cellTextRaw({ value: v.result });
    if (v.hyperlink != null && v.text != null) return String(v.text).trim();
  }
  return String(v).trim();
}

function cellText(cell) {
  return unglueParserCellText(cellTextRaw(cell));
}

/** Насколько «слипшийся» сырой текст — для выбора лучшего xlsx. */
function gluePointsForText(s) {
  const t = String(s || '');
  if (!t) return 0;
  let score = 0;
  if (/Марка автоМодель авто/i.test(t)) score += 80;
  score += (t.match(/[а-яё][А-ЯЁ]/g) || []).length * 3;
  score += (t.match(/[0-9][A-Z]{3,}\d/g) || []).length * 4;
  score += (t.match(/л\.?\s*с\.?\d{4}/gi) || []).length * 2;
  return score;
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
  const used = new Set();
  for (const k of ['sku', 'name', 'brand', 'description', 'country', 'applicability', 'analogs']) {
    for (const col of normalizeMappedColumns(mapping[k])) {
      const n = normKey(col);
      if (n) used.add(n);
    }
  }
  return used;
}

async function loadAttributeCatalog(profileId) {
  try {
    const filter = productAttributeListFilter(
      profileId != null && profileId !== '' ? profileId : null
    );
    const result = await query(
      `SELECT id, name, system_key, type, profile_id
       FROM product_attributes
       WHERE ${filter.sql}
       ORDER BY name, id`,
      filter.params
    );
    return (result.rows || []).map((r) => ({
      id: String(r.id),
      name: String(r.name || ''),
      systemKey: r.system_key != null ? String(r.system_key) : null,
      type: r.type != null ? String(r.type) : 'text',
      profileId: r.profile_id != null ? String(r.profile_id) : null,
    }));
  } catch {
    return [];
  }
}

/** Выбрать атрибут по имени с учётом категории и аккаунта (не чужой profile_id). */
function pickAttrByNames(attributes, names, { categoryAttrIds = null, profileId = null } = {}) {
  const want = new Set((names || []).map((n) => normKey(n)).filter(Boolean));
  if (!want.size) return null;
  const matches = (attributes || []).filter((a) => want.has(normKey(a.name)));
  if (!matches.length) return null;
  if (categoryAttrIds && categoryAttrIds.size) {
    const inCat = matches.find((a) => categoryAttrIds.has(String(a.id)));
    if (inCat) return inCat;
  }
  if (profileId != null && profileId !== '') {
    const same = matches.find((a) => String(a.profileId) === String(profileId));
    if (same) return same;
  }
  return matches[0];
}

function isMultilineMappingTarget(attr, mainKey = '') {
  const key = String(mainKey || '').trim();
  if (key === 'description' || key === 'applicability' || key === 'analogs') return true;
  const type = String(attr?.type || '').toLowerCase();
  if (type === 'editable') return true;
  const name = String(attr?.name || '');
  if (/применимост|аналог|описан/i.test(name)) return true;
  return false;
}

function joinMappedParts(parts, { multiline = false } = {}) {
  const list = (parts || []).map((p) => String(p || '').trim()).filter(Boolean);
  if (!list.length) return '';
  return list.join(multiline ? '\n' : '. ');
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

function cleanupExpiredIncomingUploads() {
  ensureDirSync(INCOMING_ROOT);
  let removed = 0;
  for (const name of fs.readdirSync(INCOMING_ROOT)) {
    const dir = path.join(INCOMING_ROOT, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const mp = path.join(dir, 'manifest.json');
      if (fs.existsSync(mp)) {
        const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
        if (man?.expiresAt && Date.now() > Number(man.expiresAt)) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
        continue;
      }
      const age = Date.now() - fs.statSync(dir).mtimeMs;
      if (age > SESSION_TTL_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
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
  removed += cleanupExpiredIncomingUploads();
  return removed;
}

function sanitizeUploadId(uploadId) {
  const id = String(uploadId || '')
    .trim()
    .replace(/[^a-f0-9-]/gi, '');
  if (!id || id.length < 8) {
    const err = new Error('Некорректный uploadId');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

function incomingDir(uploadId) {
  return path.join(INCOMING_ROOT, sanitizeUploadId(uploadId));
}

function readIncomingManifest(uploadId) {
  const dir = incomingDir(uploadId);
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(dir) || !fs.existsSync(mp)) {
    const err = new Error('Сессия загрузки папки не найдена или устарела');
    err.statusCode = 404;
    throw err;
  }
  const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (man?.expiresAt && Date.now() > Number(man.expiresAt)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const err = new Error('Сессия загрузки папки истекла. Выберите папку снова.');
    err.statusCode = 410;
    throw err;
  }
  return man;
}

function writeIncomingManifest(uploadId, man) {
  const dir = incomingDir(uploadId);
  ensureDirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man, null, 2), 'utf8');
}

/** Старт чанковой загрузки папки парсера */
export function initFolderUpload() {
  cleanupExpiredIncomingUploads();
  const uploadId = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  ensureDirSync(incomingDir(uploadId));
  writeIncomingManifest(uploadId, {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    files: [],
  });
  return { uploadId };
}

/**
 * Добавить чанк файлов в staging.
 * @param {string} uploadId
 * @param {Array<{ path: string, relativePath: string }>} diskFiles
 */
export function appendFolderUploadChunk(uploadId, diskFiles) {
  const man = readIncomingManifest(uploadId);
  const list = Array.isArray(diskFiles) ? diskFiles : [];
  if (!list.length) {
    const err = new Error('Пустой чанк файлов');
    err.statusCode = 400;
    throw err;
  }
  if (man.files.length + list.length > 20000) {
    const err = new Error('Слишком много файлов в папке (лимит 20000)');
    err.statusCode = 400;
    throw err;
  }
  for (const f of list) {
    const abs = String(f?.path || '');
    const rel = String(f?.relativePath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!abs || !fs.existsSync(abs) || !rel) continue;
    man.files.push({ diskName: path.basename(abs), relativePath: rel });
  }
  man.expiresAt = Date.now() + SESSION_TTL_MS;
  writeIncomingManifest(uploadId, man);
  return { uploadId, received: man.files.length };
}

/**
 * Закончить чанковую загрузку → превью сессии импорта.
 * @param {string} uploadId
 * @param {{ profileId: number|string }} opts
 */
export async function finalizeFolderUpload(uploadId, opts = {}) {
  const man = readIncomingManifest(uploadId);
  const dir = incomingDir(uploadId);
  const diskFiles = (man.files || [])
    .map((f) => ({
      path: path.join(dir, f.diskName),
      relativePath: f.relativePath,
    }))
    .filter((f) => f.path && fs.existsSync(f.path));
  try {
    return await uploadAndPreviewFromFolderFiles(diskFiles, opts);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
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
  // actualColumnCount/columnCount иногда шире первой строки (дыры в заголовках)
  const declared = Math.max(
    Number(ws.actualColumnCount) || 0,
    Number(ws.columnCount) || 0
  );
  if (declared > maxCol) maxCol = declared;
  // добрать хвост по нескольким строкам данных, если заголовок оборван
  const probeTo = Math.min(ws.rowCount || 0, 30);
  for (let r = 2; r <= probeTo; r++) {
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      if (cell.col > maxCol) maxCol = cell.col;
    });
  }
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
  let rawGlueScore = 0;
  const maxRow = Math.min(ws.rowCount || 0, MAX_PREVIEW_ROWS + 2);
  let emptyStreak = 0;
  for (let r = 2; r <= maxRow; r++) {
    const excelRow = ws.getRow(r);
    const obj = {};
    let any = false;
    for (let c = 1; c <= maxCol; c++) {
      const key = columns[c - 1];
      const raw = cellTextRaw(excelRow.getCell(c));
      if (r <= 9) rawGlueScore += gluePointsForText(raw);
      const val = unglueParserCellText(raw);
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

  return {
    columns: columns.filter((c) => !shouldSkipColumn(c)),
    rows,
    rawGlueScore,
  };
}

/**
 * Если в корне несколько .xlsx (повторный экспорт парсера) — берём самый «полный»:
 * больше столбцов, затем больше строк, затем больший файл / имя новее.
 * @param {Array<{ key?: string, path?: string, relativePath?: string, buffer: Buffer }>} candidates
 */
async function pickBestParsedXlsx(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c?.buffer?.length) : [];
  if (!list.length) {
    const err = new Error('Нет Excel для разбора');
    err.statusCode = 400;
    throw err;
  }
  let best = null;
  for (const cand of list) {
    let parsed;
    try {
      parsed = await parseWorkbookBuffer(cand.buffer);
    } catch {
      continue;
    }
    if (!parsed?.rows?.length) continue;
    const score = {
      colCount: (parsed.columns || []).length,
      rowCount: (parsed.rows || []).length,
      glue: Number(parsed.rawGlueScore) || 0,
      size: cand.buffer.length,
      name: String(cand.relativePath || cand.key || cand.path || ''),
      parsed,
      cand,
    };
    if (!best) {
      best = score;
      continue;
    }
    // Больше столбцов — главный критерий (текст при чтении разъединяем).
    // При равном числе столбцов предпочитаем файл с менее «слипшимся» сырьём.
    if (score.colCount !== best.colCount) {
      if (score.colCount > best.colCount) best = score;
      continue;
    }
    if (score.glue !== best.glue) {
      if (score.glue < best.glue) best = score;
      continue;
    }
    if (score.rowCount !== best.rowCount) {
      if (score.rowCount > best.rowCount) best = score;
      continue;
    }
    if (score.size !== best.size) {
      if (score.size > best.size) best = score;
      continue;
    }
    if (score.name.localeCompare(best.name, 'ru') > 0) best = score;
  }
  if (!best) {
    const err = new Error('Не удалось прочитать Excel (.xlsx) с данными');
    err.statusCode = 400;
    throw err;
  }
  return best;
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

/**
 * Значения из нескольких столбцов.
 * @param {string|string[]} colSpec
 * @param {{ joiner?: string, multiline?: boolean }} [opts]
 */
function resolveMappedColumnsValue(row, colSpec, opts = {}) {
  const parts = [];
  for (const col of normalizeMappedColumns(colSpec)) {
    const v = resolveMappedValue(row, col);
    if (v) parts.push(v);
  }
  if (!parts.length) return '';
  if (opts && typeof opts === 'string') {
    // обратная совместимость: раньше передавали joiner строкой
    return parts.join(opts);
  }
  if (opts?.joiner != null) return parts.join(String(opts.joiner));
  return joinMappedParts(parts, { multiline: Boolean(opts?.multiline) });
}

/** Системные атрибуты габаритов/веса → поля products.* */
const SYSTEM_DIM_PAYLOAD_KEYS = {
  product_length: 'product_length',
  product_width: 'product_width',
  product_height: 'product_height',
  product_weight: 'product_weight',
  length: 'length',
  width: 'width',
  height: 'height',
  weight: 'weight',
};

function parseLooseNumber(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(',', '.');
  if (!s) return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
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
  const xlsxCandidates = [];
  for (const key of xlsxKeys) {
    xlsxCandidates.push({
      key,
      relativePath: key,
      buffer: Buffer.from(await zip.files[key].async('uint8array')),
    });
  }
  const best = await pickBestParsedXlsx(xlsxCandidates);
  const xlsxKey = best.cand.key;
  const xlsxBuf = best.cand.buffer;
  const { columns, rows: rawRows } = best.parsed;

  const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const root = sessionDir(sessionId);
  const extractRoot = path.join(root, 'files');
  ensureDirSync(extractRoot);

  // Write chosen xlsx (лишние корневые .xlsx не копируем — иначе снова возьмётся старый)
  fs.writeFileSync(path.join(extractRoot, path.basename(zipPathParts(xlsxKey).pop())), xlsxBuf);

  // Extract image folders / files
  for (const key of fileEntries) {
    if (xlsxKeys.includes(key)) continue;
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
  const xlsxCandidates = xlsxIdx.map((i) => ({
    path: list[i].path,
    relativePath: relPaths[i],
    buffer: fs.readFileSync(list[i].path),
    index: i,
  }));
  const best = await pickBestParsedXlsx(xlsxCandidates);
  const chosenIdx = best.cand.index;
  const { columns, rows: rawRows } = best.parsed;
  const xlsxSkip = new Set(xlsxIdx.filter((i) => i !== chosenIdx));

  const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const extractRoot = path.join(sessionDir(sessionId), 'files');
  ensureDirSync(extractRoot);

  for (let i = 0; i < list.length; i++) {
    if (xlsxSkip.has(i)) continue;
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
  const attributes = await loadAttributeCatalog(profileId);
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
      type: a.type,
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
  const attributes = await loadAttributeCatalog(opts.profileId);
  // meta.attributes мог быть сохранён без фильтра профиля — берём актуальный каталог
  const attrById = new Map(attributes.map((a) => [String(a.id), a]));
  let categoryAttrIds = null;
  try {
    const cid = Number(categoryId);
    if (Number.isFinite(cid)) {
      const ca = await query(
        `SELECT attribute_id FROM category_attributes WHERE user_category_id = $1`,
        [cid]
      );
      categoryAttrIds = new Set((ca.rows || []).map((r) => String(r.attribute_id)));
    }
  } catch {
    categoryAttrIds = null;
  }
  const pickOpts = { categoryAttrIds, profileId: opts.profileId };
  const applicabilityAttr = pickAttrByNames(
    attributes,
    ['применимость', 'applicability', 'применяемость'],
    pickOpts
  );
  const analogsAttr = pickAttrByNames(attributes, ['аналоги', 'analogs', 'analogues'], pickOpts);

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
      resolveMappedColumnsValue(raw, mapping.sku, { multiline: false }) ||
      String(item.sku || '').trim();
    const name =
      resolveMappedColumnsValue(raw, mapping.name, { multiline: false }) ||
      String(item.name || '').trim() ||
      sku;
    const brandName =
      resolveMappedColumnsValue(raw, mapping.brand, { multiline: false }) ||
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
      const mappedDescription = resolveMappedColumnsValue(raw, mapping.description, {
        multiline: true,
      });
      const description =
        mappedDescription ||
        buildDescription(raw, mapping, meta.columns || [], attrColsUsed) ||
        null;
      const countryFromCol = resolveMappedColumnsValue(raw, mapping.country, {
        multiline: false,
      });
      const countryDefault = String(defaults.countryOfOrigin || defaults.country_of_origin || '').trim();
      const countryOfOrigin = countryFromCol || countryDefault || null;

      const attributeValues = {};
      const attrsToAttach = [];

      const applicabilityText = resolveMappedColumnsValue(raw, mapping.applicability, {
        multiline: isMultilineMappingTarget(applicabilityAttr, 'applicability'),
      });
      if (applicabilityText && applicabilityAttr?.id) {
        attributeValues[String(applicabilityAttr.id)] = applicabilityText;
        attrsToAttach.push(applicabilityAttr.id);
      }
      const analogsText = resolveMappedColumnsValue(raw, mapping.analogs, {
        multiline: isMultilineMappingTarget(analogsAttr, 'analogs'),
      });
      if (analogsText && analogsAttr?.id) {
        attributeValues[String(analogsAttr.id)] = analogsText;
        attrsToAttach.push(analogsAttr.id);
      }

      const dimPayload = {};
      for (const [attrId, colSpec] of Object.entries(attributeMappings || {})) {
        const aid = String(attrId || '').trim();
        const cols = normalizeMappedColumns(colSpec);
        if (!aid || !cols.length) continue;
        // Не дублируем, если уже записали через спец-поля
        if (
          (applicabilityAttr &&
            aid === String(applicabilityAttr.id) &&
            normalizeMappedColumns(mapping.applicability).length) ||
          (analogsAttr &&
            aid === String(analogsAttr.id) &&
            normalizeMappedColumns(mapping.analogs).length)
        ) {
          continue;
        }
        const attr = attrById.get(aid);
        if (!attr) continue; // чужой профиль / неизвестный id — не пишем
        const val = resolveMappedColumnsValue(raw, cols, {
          multiline: isMultilineMappingTarget(attr),
        });
        if (!val) continue;
        const sk = attr.systemKey ? String(attr.systemKey) : '';
        if (sk && SYSTEM_DIM_PAYLOAD_KEYS[sk]) {
          // Только явно сопоставленные габариты; упаковку с товара не копируем
          const num = parseLooseNumber(val);
          if (num != null) dimPayload[SYSTEM_DIM_PAYLOAD_KEYS[sk]] = num;
          continue;
        }
        if (sk) continue; // прочие системные поля карточки уже в «Сопоставление колонок»
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
        ...dimPayload,
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
  initFolderUpload,
  appendFolderUploadChunk,
  finalizeFolderUpload,
  createFromSession,
  cleanupExpiredCatalogImportSessions,
};
