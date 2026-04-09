/**
 * Импорт товаров из Excel (.xlsx), выгруженного тем же шаблоном.
 * Строка 1 — подписи, строка 2 — технические ключи (скрыта при экспорте), с 3-й — данные.
 */

import ExcelJS from 'exceljs';

export const PRODUCTS_IMPORT_SHEET = 'Товары';

/** Уникальные заголовки строки 1 → ключ (если нет строки ключей) */
const HEADER_TO_KEY_FALLBACK = {
  ID: 'id',
  Артикул: 'sku',
  Название: 'name',
  'ID в каталоге': 'ozon_product_id',
  '% выкупа (общий)': 'buyout_rate',
  Бренд: 'brand',
  Категория: 'category_name',
  Организация: 'organization_name',
  'Тип товара': 'product_type',
  'Страна производства': 'country_of_origin',
  Описание: 'description',
  Себестоимость: 'cost',
  'Доп. расходы': 'additional_expenses',
  'Дополнительные расходы': 'additional_expenses',
  'Мин. цена': 'min_price',
  Количество: 'quantity',
  'Вес (г)': 'weight',
  Длина: 'length',
  Ширина: 'width',
  Высота: 'height',
  Штрихкоды: 'barcodes',
  'Атрибуты (JSON)': null, // неоднозначно (несколько МП) — только со строкой ключей
  'Характеристики (текст)': null,
  'Черновик (JSON)': null,
  'Изображения (ссылки)': 'images_detail',
  'Ссылка на главное фото': 'image_main_url',
  'Ссылки на фото через ;': 'image_gallery_urls',
  'Изображения (JSON)': 'images',
  'Артикул продавца (WB)': 'wb_vendor_sku',
  'Название (WB)': 'wb_name',
  'Бренд (WB)': 'wb_brand',
  'Описание (WB)': 'wb_description',
  'Название (Яндекс)': 'ym_name',
  'Описание (Яндекс)': 'ym_description'
};

function normalizeCellValue(cell) {
  if (!cell) return '';
  let v = cell.value;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.richText && Array.isArray(v.richText)) {
      return v.richText.map((t) => t.text || '').join('');
    }
    if (v.text != null) return String(v.text);
    if (v.result != null) return normalizeCellValue({ value: v.result });
    if (v.hyperlink) return String(v.text || v.hyperlink || '');
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function isLikelyKeyRow(values) {
  const a = String(values[0] || '')
    .trim()
    .toLowerCase();
  const b = String(values[1] || '')
    .trim()
    .toLowerCase();
  const c = String(values[2] || '')
    .trim()
    .toLowerCase();
  return a === 'id' && b === 'sku' && c === 'name';
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeDynamicKeyByHeader(key, header) {
  const k = String(key || '').trim();
  const h = String(header || '').trim();
  if (!k || !h) return k;
  // Если экспорт дал ключ без id (mpdyn_ym_n_<hash>), но в заголовке есть "(12345)",
  // используем id из заголовка, чтобы сохранить как ym_attributes["12345"].
  const m = h.match(/\((\d+)\)\s*$/);
  if (!m?.[1]) return k;
  if (k.startsWith('mpdyn_ym_n_')) return `mpdyn_ym_${m[1]}`;
  if (k.startsWith('mpdyn_wb_n_')) return `mpdyn_wb_${m[1]}`;
  if (k.startsWith('mpdyn_ozon_n_')) return `mpdyn_ozon_${m[1]}`;
  return k;
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ rows: Record<string, unknown>[], warnings: string[] }>}
 */
export async function parseProductsImportWorkbook(buffer) {
  const warnings = [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(PRODUCTS_IMPORT_SHEET) || wb.worksheets[0];
  if (!ws) {
    return { rows: [], warnings: ['В файле нет листа с товарами'] };
  }

  let maxCol = 0;
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
    const c = cell.col;
    if (c > maxCol) maxCol = c;
  });
  if (maxCol < 3) {
    return { rows: [], warnings: ['Недостаточно колонок в первой строке'] };
  }

  const headerVals = [];
  for (let c = 1; c <= maxCol; c++) {
    headerVals.push(trimStr(normalizeCellValue(ws.getRow(1).getCell(c))));
  }

  const row2Vals = [];
  for (let c = 1; c <= maxCol; c++) {
    row2Vals.push(trimStr(normalizeCellValue(ws.getRow(2).getCell(c))));
  }

  let keys = [];
  if (isLikelyKeyRow(row2Vals)) {
    keys = row2Vals.map((k, i) => {
      const key = String(k || '').trim();
      if (!key && headerVals[i]) warnings.push(`Пустой ключ колонки ${i + 1}, столбец пропущен`);
      return key;
    });
  } else {
    warnings.push(
      'Строка 2 не распознана как ключи колонок (ожидаются id, sku, name). Используется сопоставление только по уникальным заголовкам — часть столбцов МП может не импортироваться. Лучше выгрузить файл заново из системы.'
    );
    keys = headerVals.map((h) => {
      const mapped = HEADER_TO_KEY_FALLBACK[h];
      // Если заголовок не из базового словаря — сохраняем как есть,
      // чтобы ниже можно было разобрать колонки вида "Комплект (14805799)".
      return mapped === undefined ? String(h || '').trim() : mapped;
    });
  }

  const rows = [];
  let rowNum = 3;
  const maxRow = Math.min(ws.rowCount || 0, 25000 + 2);
  let emptyStreak = 0;

  while (rowNum <= maxRow) {
    const excelRow = ws.getRow(rowNum);
    let any = false;
    const obj = {};
    for (let c = 1; c <= maxCol; c++) {
      const keyRaw = keys[c - 1];
      const key = normalizeDynamicKeyByHeader(keyRaw, headerVals[c - 1]);
      if (!key) continue;
      const raw = normalizeCellValue(excelRow.getCell(c));
      const s = trimStr(raw);
      if (s !== '' || typeof raw === 'number') any = true;
      if (Object.prototype.hasOwnProperty.call(obj, key)) continue; // первое значение по ключу
      if (typeof raw === 'number' && !Number.isNaN(raw)) obj[key] = raw;
      else if (raw === '' || raw == null) obj[key] = '';
      else obj[key] = s !== '' ? s : raw;
    }
    if (!any) {
      emptyStreak++;
      if (emptyStreak >= 25) break;
      rowNum++;
      continue;
    }
    emptyStreak = 0;
    rows.push(obj);
    rowNum++;
  }

  return { rows, warnings };
}

function normName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function parseBarcodesCell(val) {
  if (val == null || val === '') return undefined;
  const s = String(val).trim();
  if (!s) return undefined;
  return s
    .split(/[\n;,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function tryParseJson(val) {
  if (val == null || val === '') return { ok: false };
  if (typeof val === 'object') return { ok: true, value: val };
  const t = String(val).trim();
  if (!t) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

/**
 * Excel нередко даёт «650;» или «475;» (хвост ; / ,) — иначе Number(...) === NaN и атрибуты МП/ERP не сохраняются.
 */
function trimImportScalar(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return String(v).trim().replace(/^[;:,\s]+|[;:,\s]+$/g, '');
}

/** Столбцы экспорта erpdyn_<attribute_id> → attribute_values для API. */
function parseDynamicErpAttributes(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (!k.startsWith('erpdyn_')) continue;
    const id = k.slice('erpdyn_'.length);
    if (!id) continue;
    const raw = trimImportScalar(v);
    if (!raw) continue;
    const norm = normalizeEnumWordValue(raw);
    out[id] = norm !== '' ? norm : raw;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseDynamicMarketplaceAttributes(row, marketplace) {
  const out = {};
  const prefix = `mpdyn_${marketplace}_`;
  for (const [k, v] of Object.entries(row || {})) {
    if (!k.startsWith(prefix)) continue;
    const raw = trimImportScalar(v);
    if (!raw) continue;
    // Формат ключей из экспорта:
    // - mpdyn_wb_<id>
    // - mpdyn_wb_n_<hash> (если атрибут без id в схеме)
    const suffix = k.slice(prefix.length);
    if (!suffix) continue;
    if (suffix.startsWith('n_')) {
      // Для name-hash невозможно восстановить исходное имя — сохраняем под служебным ключом.
      out[`name_hash:${suffix.slice(2)}`] = raw;
      continue;
    }
    out[suffix] = raw;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeEnumWordValue(v) {
  const raw = v == null ? '' : String(v).trim();
  if (!raw) return '';
  const token = raw.toLowerCase().replace(/[;:.,\s]+$/g, '');
  if (token === 'да' || token === 'yes' || token === 'true') return 'Да';
  if (token === 'нет' || token === 'no' || token === 'false') return 'Нет';
  return trimImportScalar(raw);
}

function parseDetailTextAttributes(val) {
  if (val == null || val === '') return null;
  const text = String(val).trim();
  if (!text) return null;
  const out = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const s = String(line || '').trim();
    if (!s) continue;
    const idx = s.indexOf(':');
    if (idx <= 0) continue;
    const key = s.slice(0, idx).trim();
    const value = normalizeEnumWordValue(s.slice(idx + 1));
    if (!key || value === '') continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Строка Excel → тело create/update (без id).
 * @param {Record<string, unknown>} row
 * @param {{ categoryByNormName: Map<string, string|number>, orgAllowedByNormName: Map<string, string|number> }} lookups
 */
export function mapImportRowToApiPayload(row, lookups) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(row, k);

  const setStr = (srcKey, destKey) => {
    if (!has(srcKey)) return;
    const v = row[srcKey];
    if (v == null || v === '') {
      out[destKey] = '';
      return;
    }
    out[destKey] = String(v).trim();
  };

  const setNum = (srcKey, destKey) => {
    if (!has(srcKey)) return;
    const v = row[srcKey];
    if (v === '' || v == null) return;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[destKey] = v;
      return;
    }
    const s = trimImportScalar(v);
    if (!s) return;
    const n = Number(s.replace(',', '.'));
    if (Number.isFinite(n)) out[destKey] = n;
  };

  if (has('sku')) {
    const v = String(row.sku ?? '').trim();
    if (v) out.sku = v;
  }
  if (has('name')) {
    const v = String(row.name ?? '').trim();
    if (v) out.name = v;
  }
  setStr('brand', 'brand');
  setStr('product_type', 'product_type');
  setStr('country_of_origin', 'country_of_origin');
  setStr('description', 'description');

  // Блок WB — отдельные поля карточки МП (не ERP name/sku/brand/description)
  if (has('wb_vendor_sku')) {
    const v = String(row.wb_vendor_sku ?? '').trim();
    if (v) out.mp_wb_vendor_code = v;
  }
  if (has('wb_name')) {
    const v = String(row.wb_name ?? '').trim();
    if (v) out.mp_wb_name = v;
  }
  if (has('wb_brand')) {
    const v = String(row.wb_brand ?? '').trim();
    if (v !== '') out.mp_wb_brand = v;
  }
  if (has('wb_description')) {
    const raw = row.wb_description;
    if (raw != null && String(raw).trim() !== '') out.mp_wb_description = String(raw).trim();
  }

  // Ozon: название / бренд / текст «аннотации» — в колонках атрибутов (mpdyn_ozon_*), отдельных столбцов в шаблоне нет
  if (has('ozon_name')) {
    const v = String(row.ozon_name ?? '').trim();
    if (v) out.mp_ozon_name = v;
  }
  if (has('ozon_description')) {
    const raw = row.ozon_description;
    if (raw != null && String(raw).trim() !== '') out.mp_ozon_description = String(raw).trim();
  }
  if (has('ozon_brand')) {
    const v = String(row.ozon_brand ?? '').trim();
    if (v !== '') out.mp_ozon_brand = v;
  }

  if (has('ym_name')) {
    const v = String(row.ym_name ?? '').trim();
    if (v) out.mp_ym_name = v;
  }
  if (has('ym_description')) {
    const raw = row.ym_description;
    if (raw != null && String(raw).trim() !== '') out.mp_ym_description = String(raw).trim();
  }

  setNum('cost', 'cost');
  setNum('additional_expenses', 'additionalExpenses');
  setNum('weight', 'weight');
  setNum('length', 'length');
  setNum('width', 'width');
  setNum('height', 'height');
  setNum('min_price', 'minPrice');
  setNum('buyout_rate', 'buyout_rate');
  setNum('buyout_rate_ozon', 'buyout_rate_ozon');
  setNum('buyout_rate_wb', 'buyout_rate_wb');
  setNum('buyout_rate_ym', 'buyout_rate_ym');
  setNum('ozon_product_id', 'marketplace_ozon_product_id');

  if (has('category_name')) {
    const name = String(row.category_name || '').trim();
    if (name) {
      const id = lookups.categoryByNormName.get(normName(name));
      if (id != null) out.categoryId = id;
    }
  }
  if (has('organization_name')) {
    const name = String(row.organization_name || '').trim();
    if (name) {
      const id = lookups.orgAllowedByNormName.get(normName(name));
      if (id != null) out.organizationId = id;
    }
  }

  if (has('barcodes')) {
    const list = parseBarcodesCell(row.barcodes);
    if (list) out.barcodes = list;
  }

  const mpSkuKeys = ['sku_ozon', 'sku_wb', 'sku_ym'];
  if (mpSkuKeys.some((k) => has(k))) {
    for (const k of mpSkuKeys) {
      if (!has(k)) out[k] = '';
      else if (row[k] == null || row[k] === '') out[k] = '';
      else out[k] = String(row[k]).trim();
    }
  }

  for (const k of ['ozon_attributes', 'wb_attributes', 'ym_attributes', 'ozon_draft', 'wb_draft', 'ym_draft', 'images']) {
    if (!has(k)) continue;
    const parsed = tryParseJson(row[k]);
    if (parsed.ok) out[k] = parsed.value;
  }

  // Поддержка динамических колонок маркетплейсов из экспортного шаблона (mpdyn_*).
  // Это критично для WB атрибутов вроде "Тип щетки": они приходят отдельными колонками.
  const wbDyn = parseDynamicMarketplaceAttributes(row, 'wb');
  if (wbDyn) {
    out.wb_attributes = {
      ...(out.wb_attributes && typeof out.wb_attributes === 'object' && !Array.isArray(out.wb_attributes)
        ? out.wb_attributes
        : {}),
      ...wbDyn
    };
  }
  const ozDyn = parseDynamicMarketplaceAttributes(row, 'ozon');
  if (ozDyn) {
    out.ozon_attributes = {
      ...(out.ozon_attributes && typeof out.ozon_attributes === 'object' && !Array.isArray(out.ozon_attributes)
        ? out.ozon_attributes
        : {}),
      ...ozDyn
    };
  }
  const ymDyn = parseDynamicMarketplaceAttributes(row, 'ym');
  if (ymDyn) {
    out.ym_attributes = {
      ...(out.ym_attributes && typeof out.ym_attributes === 'object' && !Array.isArray(out.ym_attributes)
        ? out.ym_attributes
        : {}),
      ...ymDyn
    };
  }

  // Fallback для "плоских" заголовков из Excel без строки ключей:
  // "Название атрибута (14805799)" -> ym_attributes["14805799"] = "значение"
  // В первую очередь это нужно для Яндекс-параметров из таблицы.
  const ymByHeader = {};
  for (const [k, v] of Object.entries(row || {})) {
    const key = String(k || '').trim();
    if (!key) continue;
    const m = key.match(/\((\d+)\)\s*$/);
    if (!m) continue;
    const value = v == null ? '' : String(v).trim();
    if (!value) continue;
    ymByHeader[m[1]] = normalizeEnumWordValue(value);
  }
  if (Object.keys(ymByHeader).length > 0) {
    out.ym_attributes = {
      ...(out.ym_attributes && typeof out.ym_attributes === 'object' && !Array.isArray(out.ym_attributes)
        ? out.ym_attributes
        : {}),
      ...ymByHeader
    };
  }

  // Фолбэк: если пользователь заполнял текстовую колонку "Характеристики (текст)" для МП.
  // Формат строк: "Название: Значение"
  if (has('ym_attributes_detail')) {
    const parsed = parseDetailTextAttributes(row.ym_attributes_detail);
    if (parsed) {
      out.ym_attributes = {
        ...(out.ym_attributes && typeof out.ym_attributes === 'object' && !Array.isArray(out.ym_attributes)
          ? out.ym_attributes
          : {}),
        ...parsed
      };
    }
  }

  if (has('erp_attributes_named')) {
    const parsed = tryParseJson(row.erp_attributes_named);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      out.attribute_values = parsed.value;
    }
  }

  const erpDyn = parseDynamicErpAttributes(row);
  if (erpDyn) {
    out.attribute_values = {
      ...(out.attribute_values && typeof out.attribute_values === 'object' && !Array.isArray(out.attribute_values)
        ? out.attribute_values
        : {}),
      ...erpDyn
    };
  }

  return out;
}

function parseOzonDictCacheKeyForImport(cacheKey) {
  const s = String(cacheKey || '');
  const m = s.match(/^ozon:(\d+):(\d+):(\d+):limit=\d+$/);
  if (!m) return null;
  return { attrId: m[1] };
}

function parseCacheValueCellImport(cv) {
  if (cv == null) return null;
  if (typeof cv === 'object') return cv;
  if (typeof cv === 'string') {
    try {
      return JSON.parse(cv);
    } catch {
      return null;
    }
  }
  return null;
}

function importNormLabel(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Как в экспорте: «41569 — Текст» → «Текст»; голый id не используем как подпись. */
function ozonImportDisplayLabel(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  const compound = t.match(/^\d+\s*[—–-]\s*(.+)$/);
  if (compound) return compound[1].trim();
  if (/^\d+$/.test(t)) return '';
  return t;
}

/**
 * mp_dict_values → для каждого attribute_id карта «нормализованная подпись → dictionary_value_id».
 * @param {Array<{ cache_key: string, cache_value: unknown }>} mpDictValueCaches
 * @returns {Map<string, Map<string, string>>}
 */
export function buildOzonDictionaryLabelToValueIdMap(mpDictValueCaches) {
  const byAttr = new Map();
  for (const entry of mpDictValueCaches || []) {
    const parsed = parseOzonDictCacheKeyForImport(entry.cache_key);
    if (!parsed) continue;
    const raw = parseCacheValueCellImport(entry.cache_value);
    const items = Array.isArray(raw?.result) ? raw.result : [];
    const attrKey = String(parsed.attrId);
    let inner = byAttr.get(attrKey);
    if (!inner) {
      inner = new Map();
      byAttr.set(attrKey, inner);
    }
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const id = it.id != null ? String(it.id).trim() : '';
      const rawLabel =
        it.value != null
          ? String(it.value).trim()
          : it.info != null
            ? String(it.info).trim()
            : it.title != null
              ? String(it.title).trim()
              : '';
      const label = ozonImportDisplayLabel(rawLabel);
      if (!id || !label) continue;
      inner.set(importNormLabel(label), id);
    }
  }
  return byAttr;
}

/**
 * Заменяет в ozon_attributes текстовые подписи словаря на id (как в UI селекта).
 * @param {Record<string, string>} ozonAttrs
 * @param {Map<string, Map<string, string>>} labelToIdByAttrId
 */
export function resolveOzonAttributesDictionaryLabels(ozonAttrs, labelToIdByAttrId) {
  if (!ozonAttrs || typeof ozonAttrs !== 'object' || Array.isArray(ozonAttrs)) return ozonAttrs;
  if (!labelToIdByAttrId || labelToIdByAttrId.size === 0) return ozonAttrs;
  const out = { ...ozonAttrs };
  for (const [k, v] of Object.entries(out)) {
    if (v == null || v === '') continue;
    if (String(k).startsWith('name_hash:')) continue;
    let s = String(v).trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) continue;
    s = ozonImportDisplayLabel(s);
    if (!s) continue;
    const inner = labelToIdByAttrId.get(String(k));
    if (!inner) continue;
    const id = inner.get(importNormLabel(s));
    if (id != null && id !== '') out[k] = String(id);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {number|null}
 */
export function parseRowProductId(row) {
  if (!row || row.id == null || row.id === '') return null;
  const n = typeof row.id === 'number' ? row.id : parseInt(String(row.id).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
