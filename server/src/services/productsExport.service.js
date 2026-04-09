/**
 * Экспорт товаров в Excel (.xlsx).
 * Лист 1 «Товары» — сначала блок маркетплейсов (артикулы, характеристики текст/JSON, черновики), затем карточка ERP.
 * Лист 2 «Словари» — выпадающие списки для ERP + блок «атрибуты МП» из кэша API и уникальные значения из выгрузки.
 */

import ExcelJS from 'exceljs';

const CELL_MAX = 32700;
/** Имя листа со справочниками (используется в формулах Excel) */
const DICT_SHEET_NAME = 'Словари';

/** Цвета заголовков столбцов МП (ARGB). Различие по цвету, без названий маркетплейсов в тексте. */
const MP_HEADER_STYLES = {
  ozon: { fillArgb: 'FF2E75B6', fontArgb: 'FFFFFFFF' },
  wb: { fillArgb: 'FF7030A0', fontArgb: 'FFFFFFFF' },
  ym: { fillArgb: 'FFFFC000', fontArgb: 'FF000000' },
  /** Атрибуты категории ERP (отдельные столбцы erpdyn_*) */
  erp: { fillArgb: 'FF548235', fontArgb: 'FFFFFFFF' }
};

/**
 * Опции экспорта из query/UI.
 * Полный дефолт (ничего не передано): все колонки, включая атрибуты МП.
 * Общий выключатель `includeMp` / `mpFields`: при false — без колонок МП.
 * Legacy: только query mpOzon/mpWb/mpYm без includeMp — неуказанные площадки выключены.
 * Поля includeMpOzon из уже нормализованного объекта не считаются «legacy» (иначе при втором вызове ломались WB/YM).
 * Если передан includeMp — при true дочерние флаги по умолчанию true, их можно сузить (mpWb=0 и т.д.).
 * @param {object} raw
 * @returns {{ includeMp: boolean, includeMpOzon: boolean, includeMpWb: boolean, includeMpYm: boolean, includeMpAttributeColumns: boolean, mpAttributeColumnsOzon: boolean, mpAttributeColumnsWb: boolean, mpAttributeColumnsYm: boolean }}
 */
export function normalizeProductExportOptions(raw = {}) {
  const pb = (v, def = false) => {
    if (v === undefined || v === null || v === '') return def;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return def;
  };
  const anyExplicitIncludeMp = raw.includeMp !== undefined || raw.mpFields !== undefined;
  /** Только параметры HTTP-запроса; не includeMpOzon из повторной нормализации */
  const anyLegacyPerMp =
    raw.mpOzon !== undefined || raw.mpWb !== undefined || raw.mpYm !== undefined;

  let includeMp;
  let defPerMp;

  if (!anyExplicitIncludeMp && !anyLegacyPerMp) {
    includeMp = true;
    defPerMp = true;
  } else if (!anyExplicitIncludeMp && anyLegacyPerMp) {
    includeMp = true;
    defPerMp = false;
  } else {
    includeMp = pb(raw.includeMp ?? raw.mpFields, true);
    defPerMp = true;
  }

  const includeMpOzon = includeMp && pb(raw.includeMpOzon ?? raw.mpOzon, defPerMp);
  const includeMpWb = includeMp && pb(raw.includeMpWb ?? raw.mpWb, defPerMp);
  const includeMpYm = includeMp && pb(raw.includeMpYm ?? raw.mpYm, defPerMp);
  const mpAttributeColumnsOzon = includeMpOzon;
  const mpAttributeColumnsWb = includeMpWb;
  const mpAttributeColumnsYm = includeMpYm;
  const includeMpAttributeColumns = includeMpOzon || includeMpWb || includeMpYm;
  return {
    includeMp,
    includeMpOzon,
    includeMpWb,
    includeMpYm,
    includeMpAttributeColumns,
    mpAttributeColumnsOzon,
    mpAttributeColumnsWb,
    mpAttributeColumnsYm
  };
}

export function filterMpCachesForExport(caches, opts) {
  return (caches || []).filter((e) => {
    const k = String(e.cache_key || '');
    if (k.startsWith('ozon:')) return opts.includeMpOzon;
    if (k.startsWith('wb:')) return opts.includeMpWb;
    if (k.startsWith('ym:')) return opts.includeMpYm;
    return true;
  });
}

/** Кэш mp_dict_values (сейчас только Ozon: ozon:attrId:descId:typeId:limit=N). */
export function filterMpDictValueCachesForExport(caches, opts) {
  return (caches || []).filter((e) => {
    const k = String(e.cache_key || '');
    if (k.startsWith('ozon:')) return opts.includeMpOzon;
    return true;
  });
}

/** JSONB marketplace_mappings из user_categories */
export function parseUserCategoryMarketplaceMappings(raw) {
  let mm = raw;
  if (mm == null) return {};
  if (typeof mm === 'string') {
    try {
      mm = JSON.parse(mm || '{}');
    } catch {
      return {};
    }
  }
  if (typeof mm !== 'object' || Array.isArray(mm)) return {};
  return mm;
}

/**
 * Извлечь description_category_id и type_id для кэша Ozon из marketplace_mappings.ozon.
 * В БД ozon может быть: строка "ozon_17027496_96174", объект JSONB, число (только desc — тогда type из полей).
 * @param {object} mm
 * @returns {{ descId: number, typeId: number }}
 */
export function extractOzonDescTypeForCache(mm) {
  const positiveInt = (v) => {
    if (v == null || v === '') return 0;
    const n = Number(String(v).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  let descId = positiveInt(
    mm.ozon_description_category_id ?? mm.ozonDescriptionCategoryId ?? mm.ozon_descriptionCategoryId
  );
  let typeId = positiveInt(mm.ozon_type_id ?? mm.ozonTypeId ?? mm.ozon_typeId);

  const raw = mm.ozon;
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw;
    if (!descId) {
      descId = positiveInt(
        o.description_category_id ?? o.descriptionCategoryId ?? o.description_categoryId
      );
    }
    if (!typeId) typeId = positiveInt(o.type_id ?? o.typeId);
    const idStr = o.id != null ? String(o.id).trim() : '';
    if ((!descId || !typeId) && idStr && idStr !== '[object Object]') {
      let s = idStr;
      if (s.toLowerCase().startsWith('ozon_')) s = s.slice(5);
      const m = s.match(/^(\d+)_(\d+)/);
      if (m) {
        if (!descId) descId = Number(m[1]);
        if (!typeId) typeId = Number(m[2]);
      }
    }
  }

  let composite = '';
  if (raw != null && typeof raw !== 'object') {
    composite = String(raw).trim();
  } else if (raw != null && typeof raw === 'number') {
    composite = String(raw);
  }
  if (composite && composite !== '[object Object]') {
    if (composite.toLowerCase().startsWith('ozon_')) {
      composite = composite.slice(5);
    }
    if (!descId || !typeId) {
      const m = composite.match(/^(\d+)_(\d+)/);
      if (m) {
        if (!descId) descId = Number(m[1]);
        if (!typeId) typeId = Number(m[2]);
      } else if (composite.includes('_')) {
        const parts = composite.split('_').filter((p) => /^\d+$/.test(String(p).trim()));
        if (parts.length >= 2) {
          if (!descId) descId = Number(parts[0]);
          if (!typeId) typeId = Number(parts[1]);
        }
      } else if (/^\d+$/.test(composite)) {
        if (!descId) descId = Number(composite);
      }
    }
  }

  return { descId, typeId };
}

/**
 * Дополняет пару Ozon по дереву категорий из интеграции (таблица categories / API),
 * если в marketplace_mappings сохранён только один числовой id (часто это type_id листа).
 * @param {object} mm — marketplace_mappings
 * @param {object[]|null|undefined} flatOzonCategories — элементы с id, description_category_id, type_id (см. getOzonCategories)
 * @returns {{ descId: number, typeId: number }}
 */
export function resolveOzonDescTypePair(mm, flatOzonCategories) {
  let { descId, typeId } = extractOzonDescTypeForCache(mm);
  if (descId > 0 && typeId > 0) return { descId, typeId };

  const flat = Array.isArray(flatOzonCategories) ? flatOzonCategories : [];
  if (!flat.length) return { descId, typeId };

  if (typeId > 0 && descId === 0) {
    const hit = flat.find(
      (c) => Number(c.type_id) === typeId && Number(c.description_category_id) > 0
    );
    if (hit) {
      return { descId: Number(hit.description_category_id), typeId: Number(hit.type_id) };
    }
  }

  if (descId > 0 && typeId === 0) {
    const single = descId;
    for (const c of flat) {
      const id = String(c.id ?? '').trim();
      const m = id.match(/^(\d+)_(\d+)$/);
      if (m && Number(m[2]) === single) {
        return { descId: Number(m[1]), typeId: Number(m[2]) };
      }
    }
    const byType = flat.filter(
      (c) => Number(c.type_id) === single && Number(c.description_category_id) > 0
    );
    if (byType.length >= 1) {
      const pick = byType[0];
      return { descId: Number(pick.description_category_id), typeId: Number(pick.type_id) };
    }
    const byDesc = flat.filter(
      (c) => Number(c.description_category_id) === single && Number(c.type_id) > 0
    );
    if (byDesc.length === 1) {
      const pick = byDesc[0];
      return { descId: Number(pick.description_category_id), typeId: Number(pick.type_id) };
    }
  }

  return { descId, typeId };
}

/**
 * Ключи cache_entries mp_attributes, соответствующие сопоставлению категории ERP с МП.
 * Ozon: ozon:description_category_id:type_id; WB: wb:subjectId; YM: префикс ym:categoryId:
 */
function mpAttributeCacheKeysFromMarketplaceMappings(mm, flatOzonCategories) {
  const ozon = [];
  const wb = [];
  const ymPrefixes = [];

  const { descId: ozDesc, typeId: ozType } = resolveOzonDescTypePair(mm, flatOzonCategories);
  if (ozDesc > 0 && ozType > 0) {
    ozon.push(`ozon:${ozDesc}:${ozType}`);
  }

  const subjectIdRaw = mm?.wb ?? mm?.wb_subject_id ?? mm?.wbSubjectId ?? null;
  const subjectId = subjectIdRaw != null ? Number(subjectIdRaw) : 0;
  if (subjectId > 0) {
    wb.push(`wb:${subjectId}`);
  }

  const ymIdRaw = mm?.ym ?? mm?.yandex ?? null;
  const ymCategoryIdStr = ymIdRaw != null ? String(ymIdRaw).trim().replace(/\s+/g, '') : '';
  if (ymCategoryIdStr && /^\d+$/.test(ymCategoryIdStr)) {
    ymPrefixes.push(`ym:${ymCategoryIdStr}:`);
  }

  return { ozon, wb, ymPrefixes };
}

function getCategoryMappingsEntry(categoryMappingsById, cid) {
  if (!categoryMappingsById || cid == null || String(cid).trim() === '') return null;
  const k = String(cid).trim();
  if (typeof categoryMappingsById.get === 'function') {
    return categoryMappingsById.get(k) ?? categoryMappingsById.get(Number(k)) ?? null;
  }
  return categoryMappingsById[k] ?? null;
}

/**
 * Объединение ключей кэша по категориям товаров и/или явной категории (фильтр экспорта, шаблон импорта).
 * @param {object[]} products
 * @param {Record<string, object>|Map<string, object>} [categoryMappingsById] id категории → marketplace_mappings (уже объект)
 * @param {string|number|null} [exportTemplateCategoryId] категория шаблона или фильтр «Категория» в экспорте Excel — всегда подмешивается в scope при наличии
 * @param {object[]|null|undefined} [flatOzonCategories] плоский список категорий Ozon для восстановления пары desc/type из одного id
 * @returns {{ ozonKeys: Set<string>, wbKeys: Set<string>, ymPrefixes: string[] }}
 */
export function buildMpAttributeCacheScope(
  products,
  categoryMappingsById,
  exportTemplateCategoryId = null,
  flatOzonCategories = null
) {
  const oz = new Set();
  const wb = new Set();
  const ymP = [];

  const addMm = (mmRaw) => {
    const mm = typeof mmRaw === 'object' && mmRaw !== null && !Array.isArray(mmRaw) ? mmRaw : {};
    const k = mpAttributeCacheKeysFromMarketplaceMappings(mm, flatOzonCategories);
    k.ozon.forEach((x) => oz.add(x));
    k.wb.forEach((x) => wb.add(x));
    ymP.push(...k.ymPrefixes);
  };

  if (Array.isArray(products) && products.length > 0) {
    const seen = new Set();
    for (const p of products) {
      const rawId = p.categoryId ?? p.user_category_id;
      const cid = rawId != null && String(rawId).trim() !== '' ? String(rawId).trim() : '';
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const mm = getCategoryMappingsEntry(categoryMappingsById, cid);
      if (mm) addMm(mm);
    }
  }

  if (exportTemplateCategoryId != null && String(exportTemplateCategoryId).trim() !== '') {
    const mm = getCategoryMappingsEntry(categoryMappingsById, String(exportTemplateCategoryId).trim());
    if (mm) addMm(mm);
  }

  return { ozonKeys: oz, wbKeys: wb, ymPrefixes: [...new Set(ymP)] };
}

/**
 * Оставить в mp_attributes только записи, попадающие в scope (категории выгрузки / шаблона).
 * Если scope пустой (нет ни одного сопоставления МП) — пустой массив: столбцы только из фактических данных товаров.
 */
export function filterMpAttributeCachesByCategoryScope(caches, scope) {
  if (!scope) return caches || [];
  const { ozonKeys, wbKeys, ymPrefixes } = scope;
  const anyScope = ozonKeys.size > 0 || wbKeys.size > 0 || ymPrefixes.length > 0;
  if (!anyScope) return [];

  return (caches || []).filter((e) => {
    const k = String(e.cache_key || '');
    if (k.startsWith('ozon:')) return ozonKeys.has(k);
    if (k.startsWith('wb:')) return wbKeys.has(k);
    if (k.startsWith('ym:')) return ymPrefixes.some((p) => k.startsWith(p));
    return false;
  });
}

/** Ozon mp_dict_values только для description_category_id:type_id из scope. */
export function filterMpDictValueCachesForOzonCategoryScope(caches, ozonKeysSet) {
  if (!ozonKeysSet || ozonKeysSet.size === 0) {
    return (caches || []).filter((e) => !String(e.cache_key || '').startsWith('ozon:'));
  }
  return (caches || []).filter((e) => {
    const k = String(e.cache_key || '');
    if (!k.startsWith('ozon:')) return true;
    const m = k.match(/^ozon:\d+:(\d+):(\d+):limit=\d+$/);
    if (!m) return false;
    return ozonKeysSet.has(`ozon:${m[1]}:${m[2]}`);
  });
}

function filterColumnDefsByExport(cols, opts) {
  const anyMp = opts.includeMpOzon || opts.includeMpWb || opts.includeMpYm;
  return cols.filter((c) => {
    if (c.key === 'buyout_rate') return anyMp;
    const t = c.headerTone;
    if (!t) return true;
    if (t === 'erp') return true;
    if (t === 'ozon') return opts.includeMpOzon;
    if (t === 'wb') return opts.includeMpWb;
    if (t === 'ym') return opts.includeMpYm;
    return true;
  });
}

function applyMarketplaceHeaderCellStyle(cell, headerTone) {
  if (!headerTone || !MP_HEADER_STYLES[headerTone]) return;
  const s = MP_HEADER_STYLES[headerTone];
  cell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: s.fillArgb }
  };
  cell.font = { bold: true, color: { argb: s.fontArgb } };
  cell.alignment = { vertical: 'middle', wrapText: true };
}

function toCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    const s = String(v);
    return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 30)}…[обрезано]` : s;
  }
  try {
    const s = JSON.stringify(v);
    return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 30)}…[обрезано]` : s;
  } catch {
    return String(v);
  }
}

function clampText(s, max = CELL_MAX) {
  if (s == null || s === '') return '';
  const str = String(s);
  return str.length > max ? `${str.slice(0, max - 25)}…[обрезано]` : str;
}

/** JSONB из pg или строка JSON → объект */
function parseJsonb(v) {
  if (v == null || v === '') return null;
  if (Buffer.isBuffer(v)) {
    try {
      return parseJsonb(v.toString('utf8'));
    } catch {
      return null;
    }
  }
  if (typeof v === 'object' && v !== null) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    try {
      let o = JSON.parse(t);
      // Иногда в JSONB лежит строка с вложенным JSON
      if (typeof o === 'string' && o.trim() && (o.trim().startsWith('{') || o.trim().startsWith('['))) {
        try {
          o = JSON.parse(o);
        } catch {
          /* оставляем строку */
        }
      }
      return o;
    } catch {
      return null;
    }
  }
  return null;
}

/** Поле товара: snake_case из БД или camelCase с фронта */
function mpField(p, snake, camel) {
  if (p == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(p, snake) && p[snake] != null) return p[snake];
  if (camel && Object.prototype.hasOwnProperty.call(p, camel) && p[camel] != null) return p[camel];
  return undefined;
}

function isNonEmptyAttrsMap(o) {
  return Boolean(o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0);
}

/** Характеристики Ozon из ответа API в черновике */
function extractOzonAttributesFromDraft(d) {
  const draft = parseJsonb(d);
  if (!draft || typeof draft !== 'object') return null;
  const data0 = Array.isArray(draft.data) ? draft.data[0] : null;
  const items0 = Array.isArray(draft.items) ? draft.items[0] : null;
  const result0 = Array.isArray(draft.result) ? draft.result[0] : null;
  const candidates = [
    draft.attributes,
    items0?.attributes,
    draft.result?.items?.[0]?.attributes,
    result0?.attributes,
    draft.result?.attributes,
    data0?.attributes,
    draft.product?.attributes,
    draft.card?.attributes,
    draft.offer?.attributes,
    draft.model?.attributes,
    draft.info?.attributes,
    draft.attribute_values,
    items0?.attribute_values,
    result0?.attribute_values
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (Array.isArray(c) && c.length > 0) return c;
    // Ozon иногда отдаёт attribute_values как объект id → value
    if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length > 0) return c;
  }
  return null;
}

function extractWbFromDraft(d) {
  const draft = parseJsonb(d);
  if (!draft || typeof draft !== 'object') return null;
  const data0 = Array.isArray(draft.data) ? draft.data[0] : null;
  const candidates = [
    draft.characteristics,
    draft.data?.characteristics,
    data0?.characteristics,
    draft.card?.characteristics,
    draft.nomenclature?.characteristics,
    draft.nomenclatures?.[0]?.characteristics,
    draft.imt?.characteristics,
    draft.subjectCharacteristics
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (Array.isArray(c) && c.length > 0) return c;
    if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length > 0) return c;
  }
  return null;
}

function extractYmFromDraft(d) {
  const draft = parseJsonb(d);
  if (!draft || typeof draft !== 'object') return null;
  const candidates = [
    draft.parameters,
    draft.parameterValues,
    draft.offer?.parameterValues,
    draft.offer?.parameters,
    draft.result?.parameters,
    draft.mapping?.parameters,
    Array.isArray(draft.mapping?.parameterValues) ? draft.mapping.parameterValues : null
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (Array.isArray(c) && c.length > 0) return c;
    if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length > 0) return c;
  }
  return null;
}

function formatScalar(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(formatScalar).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    return (
      v.value ??
      v.dictionary_value_name ??
      v.name ??
      v.text ??
      (() => {
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      })()
    );
  }
  return String(v);
}

function extractOzonValue(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    return formatScalar(v.value ?? v.dictionary_value_name ?? v);
  }
  return String(v);
}

/** Сырое объединённое значение Ozon (карта id→value или массив из API) */
function getMergedOzonRaw(p) {
  const direct = parseJsonb(mpField(p, 'ozon_attributes', 'ozonAttributes'));
  if (isNonEmptyAttrsMap(direct) || (Array.isArray(direct) && direct.length > 0)) return direct;
  return extractOzonAttributesFromDraft(mpField(p, 'ozon_draft', 'ozonDraft'));
}

function getMergedWbRaw(p) {
  const direct = parseJsonb(mpField(p, 'wb_attributes', 'wbAttributes'));
  if (isNonEmptyAttrsMap(direct) || (Array.isArray(direct) && direct.length > 0)) return direct;
  return extractWbFromDraft(mpField(p, 'wb_draft', 'wbDraft'));
}

function getMergedYmRaw(p) {
  const direct = parseJsonb(mpField(p, 'ym_attributes', 'ymAttributes'));
  if (isNonEmptyAttrsMap(direct) || (Array.isArray(direct) && direct.length > 0)) return direct;
  return extractYmFromDraft(mpField(p, 'ym_draft', 'ymDraft'));
}

/**
 * @returns {{ attribute_id: string, attribute_name: string, value: string }[]}
 */
function normalizeOzonToRows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const id = item.id ?? item.attribute_id ?? '';
        const name = item.name ?? item.attribute_name ?? item.title ?? (id !== '' && id != null ? `Атрибут ${id}` : '');
        let value = '';
        if (Array.isArray(item.values) && item.values.length > 0) {
          value = item.values.map((x) => extractOzonValue(x)).filter(Boolean).join(', ');
        } else if (item.value !== undefined && item.value !== null) {
          value = formatScalar(item.value);
        }
        return {
          attribute_id: id !== '' && id != null ? String(id) : '',
          attribute_name: name ? String(name) : String(id),
          value: value
        };
      })
      .filter(Boolean);
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw).map(([k, v]) => ({
      attribute_id: k,
      attribute_name: k,
      value: formatScalar(v)
    }));
  }
  return [];
}

function normalizeWbToRows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((c) => {
        if (!c || typeof c !== 'object') return null;
        const id = c.id ?? c.characteristic_id ?? c.charcID ?? '';
        const name = c.name ?? c.charcName ?? (id !== '' && id != null ? `Характеристика ${id}` : '');
        const val = Array.isArray(c.value) ? c.value.map((x) => formatScalar(x)).join(', ') : formatScalar(c.value);
        return {
          attribute_id: id !== '' && id != null ? String(id) : '',
          attribute_name: name ? String(name) : String(id),
          value: val
        };
      })
      .filter(Boolean);
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw).map(([k, v]) => ({
      attribute_id: k,
      attribute_name: k,
      value: formatScalar(v)
    }));
  }
  return [];
}

function normalizeYmToRows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((x) => {
        if (x == null) return null;
        if (typeof x !== 'object') {
          return { attribute_id: '', attribute_name: '', value: formatScalar(x) };
        }
        const id = x.id ?? x.parameterId ?? '';
        const name = x.name ?? x.parameterName ?? x.title ?? (id ? String(id) : '');
        const value = formatScalar(x.value ?? x.values ?? x);
        return {
          attribute_id: id !== '' && id != null ? String(id) : '',
          attribute_name: name ? String(name) : '',
          value
        };
      })
      .filter(Boolean);
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw).map(([k, v]) => ({
      attribute_id: k,
      attribute_name: k,
      value: formatScalar(v)
    }));
  }
  return [];
}

/** Уникальные значения атрибутов МП по ключу «Маркетплейс|id» или «Маркетплейс||название» */
function buildMpAttrValueAggregate(products) {
  const m = new Map();
  const bump = (mpLabel, id, name, val) => {
    const s = val != null ? String(val).trim() : '';
    if (!s) return;
    const key =
      id != null && String(id).trim() !== ''
        ? `${mpLabel}|${String(id).trim()}`
        : `${mpLabel}||${String(name || '').trim() || '_'}`;
    if (!m.has(key)) m.set(key, new Set());
    m.get(key).add(s);
  };
  for (const p of products) {
    for (const row of normalizeOzonToRows(getMergedOzonRaw(p))) {
      bump('Ozon', row.attribute_id, row.attribute_name, row.value);
    }
    for (const row of normalizeWbToRows(getMergedWbRaw(p))) {
      bump('Wildberries', row.attribute_id, row.attribute_name, row.value);
    }
    for (const row of normalizeYmToRows(getMergedYmRaw(p))) {
      bump('Яндекс.Маркет', row.attribute_id, row.attribute_name, row.value);
    }
  }
  return m;
}

function parseCacheValueCell(cv) {
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

/** Ненулевой справочник Ozon в сыром объекте API (поля могут отличаться по версии ответа). */
function ozonEffectiveDictionaryId(a) {
  if (!a || typeof a !== 'object') return 0;
  const keys = ['dictionary_id', 'attribute_dictionary_id', 'dictionaryId', 'dictionaryID'];
  for (const k of keys) {
    const v = a[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function extractOzonSchemaValueStrings(a) {
  if (!a || typeof a !== 'object') return null;
  const candidates = [a.values, a.options, a.collection, a.allowed_values, a.allowedValues, a.attribute_values].find(
    (x) => Array.isArray(x) && x.length > 0
  );
  if (!candidates) return null;
  const out = [];
  for (const x of candidates) {
    if (x == null) continue;
    if (typeof x === 'string' || typeof x === 'number') {
      const s = String(x).trim();
      if (s) out.push(s);
      continue;
    }
    if (typeof x === 'object') {
      const s = String(x.value ?? x.name ?? x.title ?? x.id ?? '').trim();
      if (s) out.push(s);
    }
  }
  const uniq = [...new Set(out)].filter(Boolean);
  return uniq.length ? uniq : null;
}

function parseOzonSchemaFromCache(val) {
  let arr = Array.isArray(val) ? val : [];
  if (!arr.length && val && typeof val === 'object' && Array.isArray(val.result)) {
    arr = val.result;
  }
  if (!arr.length && val && typeof val === 'object' && Array.isArray(val.attributes)) {
    arr = val.attributes;
  }
  return arr
    .map((a) => {
      const eff = ozonEffectiveDictionaryId(a);
      const rawD = a?.dictionary_id;
      const nRaw = rawD != null && rawD !== '' ? Number(rawD) : 0;
      const dictionary_id =
        eff > 0 ? eff : Number.isFinite(nRaw) && nRaw > 0 ? nRaw : null;
      return {
        id: a?.id ?? a?.attribute_id,
        name: (a?.name && String(a.name).trim()) || (a?.id != null ? `Атрибут ${a.id}` : ''),
        type: a?.type ?? a?.attribute_type ?? '',
        dictionary_id,
        allowedList: extractOzonSchemaValueStrings(a)
      };
    })
    .filter((x) => x.id != null && String(x.id).trim() !== '');
}

function ozonTypeHint(a) {
  const parts = [];
  if (a.type) parts.push(`type=${a.type}`);
  const d = ozonEffectiveDictionaryId(a) || (a.dictionary_id != null && a.dictionary_id !== '' ? Number(a.dictionary_id) : 0);
  if (d) parts.push(`dictionary_id=${d}`);
  return parts.join('; ') || '—';
}

function extractWbCharacteristicAllowedStrings(c) {
  if (!c || typeof c !== 'object') return null;
  const raw =
    (Array.isArray(c.charcValues) && c.charcValues) ||
    (Array.isArray(c.values) && c.values) ||
    (Array.isArray(c.allowedValues) && c.allowedValues) ||
    null;
  if (!raw || !raw.length) return null;
  const out = [];
  for (const x of raw) {
    if (x == null) continue;
    if (typeof x === 'string' || typeof x === 'number') {
      const s = String(x).trim();
      if (s) out.push(s);
      continue;
    }
    if (typeof x === 'object') {
      const s = String(x.value ?? x.name ?? x.wbName ?? x.objectName ?? '').trim();
      if (s) out.push(s);
    }
  }
  const uniq = [...new Set(out)].filter(Boolean);
  return uniq.length ? uniq : null;
}

/**
 * Справочник значений WB: id варианта → подпись (из charcValues в кэше схемы subject).
 * @returns {Map<string,string>|null}
 */
function extractWbCharcValueIdToLabelMap(c) {
  if (!c || typeof c !== 'object') return null;
  const raw =
    (Array.isArray(c.charcValues) && c.charcValues) ||
    (Array.isArray(c.values) && c.values) ||
    (Array.isArray(c.allowedValues) && c.allowedValues) ||
    null;
  if (!raw || !raw.length) return null;
  const m = new Map();
  for (const x of raw) {
    if (x == null || typeof x !== 'object') continue;
    const vid = x.id ?? x.valueId ?? x.charcValueId ?? x.charcValueID ?? x.charc_value_id;
    let label = x.value ?? x.name ?? x.wbName ?? x.objectName ?? x.valueName;
    if (label != null && typeof label === 'object') {
      label = label.name ?? label.value ?? label.text;
    }
    if (vid != null && label != null && String(label).trim() !== '') {
      m.set(String(vid).trim(), String(label).trim());
    }
  }
  return m.size ? m : null;
}

function parseWbSchemaFromCache(val) {
  const arr = Array.isArray(val) ? val : [];
  return arr
    .map((c) => {
      const id = c?.charcID ?? c?.id ?? c?.characteristic_id;
      return {
        id,
        name: (c?.name && String(c.name).trim()) || (c?.charcName && String(c.charcName).trim()) || (id != null ? `Хар-ка ${id}` : ''),
        type: c?.charcType ?? c?.unitName ?? '',
        allowedList: extractWbCharacteristicAllowedStrings(c),
        valueIdToLabel: extractWbCharcValueIdToLabelMap(c)
      };
    })
    .filter((x) => x.id != null && String(x.id).trim() !== '');
}

function ymDictionaryHint(p) {
  if (!p || typeof p !== 'object') return '—';
  const opts = p.dictionary_options;
  if (Array.isArray(opts) && opts.length > 0) {
    return clampText(
      opts
        .slice(0, 40)
        .map((o) => `${o.id}:${o.label ?? o.value ?? o.id}`)
        .join('; '),
      8000
    );
  }
  return [p.type, p.ym_parameter_type].filter(Boolean).join(' / ') || '—';
}

function parseYmSchemaFromCache(val) {
  const arr = Array.isArray(val) ? val : [];
  return arr
    .filter((p) => p && p.id != null)
    .map((p) => ({
      id: p.id,
      name: p.name || `Параметр ${p.id}`,
      hint: ymDictionaryHint(p),
      dictionary_options: Array.isArray(p.dictionary_options) ? p.dictionary_options : null
    }));
}

/** 012345 и 12345 — один и тот же параметр в схеме и в данных */
function normalizeNumericAttrIdStr(id) {
  const s = String(id).trim();
  if (!/^\d+$/.test(s)) return s;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? String(n) : s;
}

/** Макс. отдельных столбцов на один маркетплейс (остальные остаются в JSON/тексте). */
const MAX_DYNAMIC_MP_COLS_PER_MARKETPLACE = 150;
const MAX_ERP_DYNAMIC_COLS = 200;

/**
 * По одному столбцу на атрибут категории ERP из product_attribute_values (ключи erpdyn_<id>).
 */
function gatherErpDynamicSpecs(products) {
  const list = Array.isArray(products) ? products : [];
  const idSet = new Set();
  const idToName = new Map();
  for (const p of list) {
    const meta = p._erp_attr_id_to_name;
    if (meta && typeof meta === 'object') {
      for (const [id, name] of Object.entries(meta)) {
        if (name) idToName.set(String(id), String(name));
      }
    }
    const av = p.attribute_values;
    if (av && typeof av === 'object' && !Array.isArray(av)) {
      for (const id of Object.keys(av)) {
        if (id) idSet.add(String(id));
      }
    }
  }
  const ids = [...idSet].sort((a, b) => {
    const na = idToName.get(a) || '';
    const nb = idToName.get(b) || '';
    if (na && nb) return na.localeCompare(nb, 'ru');
    const naNum = Number(a);
    const nbNum = Number(b);
    if (Number.isFinite(naNum) && Number.isFinite(nbNum)) return naNum - nbNum;
    return String(a).localeCompare(String(b), 'ru');
  });
  return ids.slice(0, MAX_ERP_DYNAMIC_COLS).map((id) => {
    const name = idToName.get(id) || `Атрибут ${id}`;
    return {
      key: `erpdyn_${id}`,
      header: `${name} (${id})`,
      attrId: id
    };
  });
}

/**
 * Имена атрибутов из кэша mp_attributes (все ключи категорий; при конфликте — более длинное имя).
 * @returns {{ ozon: Map<string,string>, wb: Map<string,string>, ym: Map<string,string> }}
 */
function buildMpAttrDisplayNamesFromCaches(mpAttributeCaches) {
  const ozon = new Map();
  const wb = new Map();
  const ym = new Map();
  const bump = (map, idStr, label) => {
    const prev = map.get(idStr);
    if (!prev || String(label).length > String(prev).length) map.set(idStr, String(label).trim());
  };
  for (const entry of mpAttributeCaches || []) {
    const cacheKey = entry.cache_key != null ? String(entry.cache_key) : '';
    const raw = parseCacheValueCell(entry.cache_value);
    if (!cacheKey || raw == null) continue;
    if (cacheKey.startsWith('ozon:')) {
      for (const a of parseOzonSchemaFromCache(raw)) {
        const idRaw = String(a.id).trim();
        const idStr = /^\d+$/.test(idRaw) ? normalizeNumericAttrIdStr(idRaw) : idRaw;
        const label = (a.name && String(a.name).trim()) || `Атрибут ${a.id}`;
        bump(ozon, idStr, label);
      }
    } else if (cacheKey.startsWith('wb:')) {
      for (const a of parseWbSchemaFromCache(raw)) {
        const idRaw = String(a.id).trim();
        const idStr = /^\d+$/.test(idRaw) ? normalizeNumericAttrIdStr(idRaw) : idRaw;
        const label = (a.name && String(a.name).trim()) || `Хар-ка ${a.id}`;
        bump(wb, idStr, label);
      }
    } else if (cacheKey.startsWith('ym:')) {
      for (const a of parseYmSchemaFromCache(raw)) {
        const idRaw = String(a.id).trim();
        const idStr = /^\d+$/.test(idRaw) ? normalizeNumericAttrIdStr(idRaw) : idRaw;
        const label = (a.name && String(a.name).trim()) || `Параметр ${a.id}`;
        bump(ym, idStr, label);
      }
    }
  }
  return { ozon, wb, ym };
}

function simpleNameHash(s) {
  const t = String(s || '');
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

function stableDynamicColKey(marketplace, attrId, attrName) {
  const safe = (x) =>
    String(x)
      .replace(/[^\w\u0400-\u04FF\-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 80);
  if (attrId) return `mpdyn_${marketplace}_${safe(attrId)}`;
  return `mpdyn_${marketplace}_n_${simpleNameHash(attrName || 'x')}`;
}

/**
 * Сколько товаров содержат каждую характеристику (для приоритета столбцов).
 * @returns {Map<string, { attrId: string, attrName: string, sampleName: string, productCount: number }>}
 */
function gatherDynamicAttributeStats(products, normalizeFn, getRawFn) {
  const stats = new Map();
  for (const p of products) {
    const rows = normalizeFn(getRawFn(p));
    const seen = new Set();
    for (const row of rows) {
      let id = row.attribute_id != null ? String(row.attribute_id).trim() : '';
      if (id && /^\d+$/.test(id)) id = normalizeNumericAttrIdStr(id);
      const nm = row.attribute_name != null ? String(row.attribute_name).trim() : '';
      if (!id && !nm) continue;
      const sk = id ? `i:${id}` : `n:${nm.toLowerCase()}`;
      if (seen.has(sk)) continue;
      seen.add(sk);
      const prev = stats.get(sk);
      if (prev) {
        prev.productCount += 1;
        if (nm.length > (prev.sampleName || '').length) prev.sampleName = nm;
      } else {
        stats.set(sk, {
          attrId: id,
          attrName: nm,
          sampleName: nm || id,
          productCount: 1
        });
      }
    }
  }
  return stats;
}

/**
 * Добавляет в stats характеристики из кэша mp_attributes (схемы категорий), которых нет в данных товаров.
 * Иначе при пустых ozon_attributes/wb/ym в БД отдельных столбцов не будет — только JSON/текст.
 */
function mergeMpCacheIntoDynamicStats(stats, marketplace, mpAttributeCaches) {
  const prefix =
    marketplace === 'ozon' ? 'ozon:' : marketplace === 'wb' ? 'wb:' : marketplace === 'ym' ? 'ym:' : '';
  if (!prefix) return;
  for (const entry of mpAttributeCaches || []) {
    const cacheKey = entry.cache_key != null ? String(entry.cache_key) : '';
    if (!cacheKey.startsWith(prefix)) continue;
    const raw = parseCacheValueCell(entry.cache_value);
    if (raw == null) continue;
    const attrs =
      marketplace === 'ozon'
        ? parseOzonSchemaFromCache(raw)
        : marketplace === 'wb'
          ? parseWbSchemaFromCache(raw)
          : parseYmSchemaFromCache(raw);
    for (const a of attrs) {
      const idRaw = a?.id ?? a?.attribute_id ?? a?.characteristic_id;
      if (idRaw == null || String(idRaw).trim() === '') continue;
      let idStr = String(idRaw).trim();
      if (/^\d+$/.test(idStr)) idStr = normalizeNumericAttrIdStr(idStr);
      const sk = `i:${idStr}`;
      if (stats.has(sk)) continue;
      const nm =
        (a.name && String(a.name).trim()) ||
        (a.charcName && String(a.charcName).trim()) ||
        (marketplace === 'ozon' ? `Атрибут ${idStr}` : marketplace === 'wb' ? `Хар-ка ${idStr}` : `Параметр ${idStr}`);
      stats.set(sk, {
        attrId: idStr,
        attrName: nm,
        sampleName: nm,
        productCount: 0
      });
    }
  }
}

/**
 * Один и тот же параметр Яндекс/Ozon/WB мог попасть в stats и как i:числовой_id (кэш), и как i:текст_имени (из ym_attributes без id).
 * Тогда в Excel два столбца с одним заголовком. Сливаем по id из nameMap (подпись → id).
 * @param {Map<string, { attrId: string, attrName: string, sampleName: string, productCount: number }>} stats
 * @param {Map<string,string>} nameMap
 */
function dedupeDynamicStatsByCanonicalId(stats, nameMap) {
  if (!stats || stats.size === 0) return stats;
  const labelToId = new Map();
  for (const [id, lab] of nameMap) {
    const k = String(lab).trim().toLowerCase();
    if (!labelToId.has(k)) labelToId.set(k, normalizeNumericAttrIdStr(String(id)));
  }
  const merged = new Map();
  for (const [sk, v] of stats) {
    let id = v.attrId != null && String(v.attrId).trim() !== '' ? String(v.attrId).trim() : '';
    const nm = (v.sampleName || v.attrName || '').trim();
    if (id && !/^\d+$/.test(id)) {
      const lid = labelToId.get(id.toLowerCase());
      if (lid) id = lid;
    }
    if (!id && nm) {
      const lid = labelToId.get(nm.toLowerCase());
      if (lid) id = lid;
    }
    if (id && /^\d+$/.test(id)) id = normalizeNumericAttrIdStr(id);
    const mergeKey = id ? `i:${id}` : sk;
    const prev = merged.get(mergeKey);
    if (!prev) {
      merged.set(mergeKey, {
        attrId: id || '',
        attrName: v.attrName || v.sampleName || '',
        sampleName: v.sampleName || v.attrName || '',
        productCount: v.productCount
      });
    } else {
      prev.productCount += v.productCount;
      const sn = v.sampleName || v.attrName || '';
      if (sn.length > (prev.sampleName || '').length) prev.sampleName = sn;
      if (!prev.attrId && id) prev.attrId = id;
    }
  }
  return merged;
}

/** Если после stats всё ещё два столбца с одним заголовком на одном МП — оставляем лучший (числовой id, без name-hash). */
function dedupeDynamicSpecsByMarketplaceAndHeader(specs) {
  if (!specs || specs.length < 2) return specs;
  const headerKey = (s) =>
    `${s.marketplace}|${String(s.header || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')}`;
  const scoreSpec = (s) => {
    let sc = 0;
    const id = s.attrId != null ? String(s.attrId).trim() : '';
    if (id && /^\d+$/.test(id)) sc += 200;
    if (id && !/^\d+$/.test(id)) sc += 20;
    if (s.key && !String(s.key).includes('_n_')) sc += 50;
    return sc;
  };
  const pick = (a, b) => (scoreSpec(b) > scoreSpec(a) ? b : a);
  const seen = new Map();
  const out = [];
  for (const s of specs) {
    const hk = headerKey(s);
    if (!seen.has(hk)) {
      seen.set(hk, out.length);
      out.push(s);
    } else {
      const idx = seen.get(hk);
      out[idx] = pick(out[idx], s);
    }
  }
  return out;
}

/**
 * @returns {{ key: string, header: string, marketplace: string, attrId: string, attrName: string }[]}
 * Заголовки без названия маркетплейса — различие по цвету столбца (см. headerTone при сборке colDefs).
 */
function statsToDynamicSpecs(marketplace, stats, nameMap, maxCols) {
  const arr = [...stats.values()]
    .sort((a, b) => {
      if (b.productCount !== a.productCount) return b.productCount - a.productCount;
      const na = a.attrId && /^\d+$/.test(a.attrId) ? parseInt(a.attrId, 10) : Number.MAX_SAFE_INTEGER;
      const nb = b.attrId && /^\d+$/.test(b.attrId) ? parseInt(b.attrId, 10) : Number.MAX_SAFE_INTEGER;
      if (na !== nb) return na - nb;
      return String(a.sampleName || '').localeCompare(String(b.sampleName || ''), 'ru');
    })
    .slice(0, maxCols);

  return arr.map((v) => {
    let id = v.attrId != null && String(v.attrId).trim() !== '' ? String(v.attrId).trim() : '';
    if (id && /^\d+$/.test(id)) id = normalizeNumericAttrIdStr(id);
    let title = '';
    if (id && nameMap.has(String(id))) title = nameMap.get(String(id));
    if (!title) title = v.sampleName || (id ? String(id) : '');
    if (title.length > 50) title = `${title.slice(0, 47)}…`;
    const header = title;
    const key = stableDynamicColKey(marketplace, id, v.attrName || v.sampleName || '');
    return {
      key,
      header,
      marketplace,
      attrId: id || '',
      attrName: v.attrName || v.sampleName || ''
    };
  });
}

function buildMpAttrLookupMaps(p) {
  const fill = (rows) => {
    const byId = new Map();
    const byName = new Map();
    for (const r of rows) {
      let id = r.attribute_id != null ? String(r.attribute_id).trim() : '';
      if (id && /^\d+$/.test(id)) id = normalizeNumericAttrIdStr(id);
      const nm = r.attribute_name != null ? String(r.attribute_name).trim().toLowerCase() : '';
      if (id) byId.set(id, r.value);
      if (nm) byName.set(nm, r.value);
    }
    return { byId, byName };
  };
  const oz = fill(normalizeOzonToRows(getMergedOzonRaw(p)));
  const wb = fill(normalizeWbToRows(getMergedWbRaw(p)));
  const ym = fill(normalizeYmToRows(getMergedYmRaw(p)));
  return { ozon: oz, wb, ym };
}

function pickDynamicValueFromMaps(maps, spec) {
  const block = spec.marketplace === 'ozon' ? maps.ozon : spec.marketplace === 'wb' ? maps.wb : maps.ym;
  if (spec.attrId) {
    const hit = block.byId.get(String(spec.attrId));
    return hit !== undefined && hit !== null ? hit : '';
  }
  const k = String(spec.attrName || '').trim().toLowerCase();
  const hit = block.byName.get(k);
  return hit !== undefined && hit !== null ? hit : '';
}

/** @param {Map<string, Map<string,string>>} byAttr */
function resolveIdsToLabels(rawVal, byAttr, attrId) {
  if (rawVal === undefined || rawVal === null) return rawVal;
  const aid = attrId != null ? String(attrId).trim() : '';
  if (!aid || !byAttr) return rawVal;
  const inner = byAttr.get(aid);
  if (!inner || inner.size === 0) return rawVal;
  const s = String(rawVal).trim();
  if (!s) return rawVal;
  const parts = s.split(/\s*,\s*/).filter(Boolean);
  if (parts.length <= 1) {
    const hit = inner.get(s);
    return hit !== undefined ? hit : rawVal;
  }
  return parts.map((p) => inner.get(p.trim()) ?? p.trim()).join(', ');
}

/**
 * Подстановка человекочитаемых подписей вместо id из справочников (кэш схемы / mp_dict_values).
 * @param {{ wbValueIdToLabel?: Map<string, Map<string,string>>, ozonValueIdToLabel?: Map<string, Map<string,string>>, ymValueIdToLabel?: Map<string, Map<string,string>> }} ctx
 */
function resolveDynamicDisplayValue(spec, rawVal, ctx) {
  if (ctx == null || rawVal === undefined || rawVal === null) return rawVal;
  const mp = spec.marketplace;
  if (mp === 'wb') return resolveIdsToLabels(rawVal, ctx.wbValueIdToLabel, spec.attrId);
  if (mp === 'ozon') return resolveIdsToLabels(rawVal, ctx.ozonValueIdToLabel, spec.attrId);
  if (mp === 'ym') return resolveIdsToLabels(rawVal, ctx.ymValueIdToLabel, spec.attrId);
  return rawVal;
}

function buildWbCharcValueIdToLabelByCharcId(mpAttributeCaches) {
  const out = new Map();
  const bump = (charcId, vid, label) => {
    const ck = String(charcId).trim();
    const vks = String(vid).trim();
    const lab = String(label).trim();
    if (!ck || !vks || !lab) return;
    if (!out.has(ck)) out.set(ck, new Map());
    const inner = out.get(ck);
    const prev = inner.get(vks);
    if (!prev || lab.length > prev.length) inner.set(vks, lab);
  };
  for (const entry of mpAttributeCaches || []) {
    if (!String(entry.cache_key || '').startsWith('wb:')) continue;
    const raw = parseCacheValueCell(entry.cache_value);
    for (const a of parseWbSchemaFromCache(raw)) {
      if (!a.valueIdToLabel) continue;
      for (const [vid, lab] of a.valueIdToLabel) {
        bump(a.id, vid, lab);
      }
    }
  }
  return out;
}

/** Подпись значения Ozon из ответа attribute/values (id — текст или только текст). */
function ozonDictRawToLabel(rawLabel) {
  const t = String(rawLabel ?? '').trim();
  if (!t) return '';
  const compound = t.match(/^\d+\s*[—–-]\s*(.+)$/);
  if (compound) return compound[1].trim();
  if (/^\d+$/.test(t)) return '';
  return t;
}

/** id значения Ozon → подпись из кэша mp_dict_values */
function buildOzonValueIdToLabelByAttrId(mpDictValueCaches) {
  const out = new Map();
  for (const entry of mpDictValueCaches || []) {
    const parsed = parseOzonDictCacheKey(entry.cache_key);
    if (!parsed) continue;
    const raw = parseCacheValueCell(entry.cache_value);
    const items = Array.isArray(raw?.result) ? raw.result : Array.isArray(raw) ? raw : [];
    const attrKey = String(parsed.attrId);
    if (!out.has(attrKey)) out.set(attrKey, new Map());
    const inner = out.get(attrKey);
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const vid = it.id ?? it.value_id ?? it.dictionary_value_id;
      if (vid == null) continue;
      const rawLabel = it.value ?? it.info ?? it.title ?? it.name;
      if (rawLabel == null) continue;
      const display = ozonDictRawToLabel(String(rawLabel).trim());
      const vks = String(vid).trim();
      const lab = display || String(rawLabel).trim();
      if (!lab) continue;
      const prev = inner.get(vks);
      if (!prev || lab.length > prev.length) inner.set(vks, lab);
    }
  }
  return out;
}

function buildYmValueIdToLabelByParamId(mpAttributeCaches) {
  const out = new Map();
  for (const entry of mpAttributeCaches || []) {
    if (!String(entry.cache_key || '').startsWith('ym:')) continue;
    const raw = parseCacheValueCell(entry.cache_value);
    for (const a of parseYmSchemaFromCache(raw)) {
      if (!a.dictionary_options || !a.dictionary_options.length) continue;
      const pid = String(a.id);
      if (!out.has(pid)) out.set(pid, new Map());
      const inner = out.get(pid);
      for (const o of a.dictionary_options) {
        if (!o || o.id == null) continue;
        const lab = o.label != null ? String(o.label).trim() : o.value != null ? String(o.value).trim() : '';
        if (!lab) continue;
        const oid = String(o.id).trim();
        const prev = inner.get(oid);
        if (!prev || lab.length > prev.length) inner.set(oid, lab);
      }
    }
  }
  return out;
}

/**
 * Полный список колонок листа «Товары»: фиксированные + по столбцу на каждую характеристику МП из выгрузки.
 */
function buildProductSheetColumns(products, mpAttributeCaches, exportOpts) {
  const opts = normalizeProductExportOptions(exportOpts);
  const caches = Array.isArray(mpAttributeCaches) ? mpAttributeCaches : [];
  const nameMaps = buildMpAttrDisplayNamesFromCaches(caches);

  const ozStats = gatherDynamicAttributeStats(products, normalizeOzonToRows, getMergedOzonRaw);
  const wbStats = gatherDynamicAttributeStats(products, normalizeWbToRows, getMergedWbRaw);
  const ymStats = gatherDynamicAttributeStats(products, normalizeYmToRows, getMergedYmRaw);

  if (opts.includeMpOzon) mergeMpCacheIntoDynamicStats(ozStats, 'ozon', caches);
  if (opts.includeMpWb) mergeMpCacheIntoDynamicStats(wbStats, 'wb', caches);
  if (opts.includeMpYm) mergeMpCacheIntoDynamicStats(ymStats, 'ym', caches);

  const ozStatsDeduped = opts.includeMpOzon ? dedupeDynamicStatsByCanonicalId(ozStats, nameMaps.ozon) : ozStats;
  const wbStatsDeduped = opts.includeMpWb ? dedupeDynamicStatsByCanonicalId(wbStats, nameMaps.wb) : wbStats;
  const ymStatsDeduped = opts.includeMpYm ? dedupeDynamicStatsByCanonicalId(ymStats, nameMaps.ym) : ymStats;

  const wbSpecs =
    opts.includeMpWb && opts.mpAttributeColumnsWb
      ? dedupeDynamicSpecsByMarketplaceAndHeader(
          statsToDynamicSpecs('wb', wbStatsDeduped, nameMaps.wb, MAX_DYNAMIC_MP_COLS_PER_MARKETPLACE)
        )
      : [];
  const ozSpecs =
    opts.includeMpOzon && opts.mpAttributeColumnsOzon
      ? dedupeDynamicSpecsByMarketplaceAndHeader(
          statsToDynamicSpecs('ozon', ozStatsDeduped, nameMaps.ozon, MAX_DYNAMIC_MP_COLS_PER_MARKETPLACE)
        )
      : [];
  const ymSpecs =
    opts.includeMpYm && opts.mpAttributeColumnsYm
      ? dedupeDynamicSpecsByMarketplaceAndHeader(
          statsToDynamicSpecs('ym', ymStatsDeduped, nameMaps.ym, MAX_DYNAMIC_MP_COLS_PER_MARKETPLACE)
        )
      : [];

  /** Порядок: WB → Ozon → Яндекс (как на листе) */
  const dynamicSpecs = [...wbSpecs, ...ozSpecs, ...ymSpecs];
  const specToCol = (s) => ({
    header: s.header,
    key: s.key,
    width: 24,
    headerTone: s.marketplace
  });
  const wbDynamicCols = wbSpecs.map(specToCol);
  const ozDynamicCols = ozSpecs.map(specToCol);
  const ymDynamicCols = ymSpecs.map(specToCol);

  const erpDynamicSpecs = gatherErpDynamicSpecs(products);
  const erpDynamicCols = erpDynamicSpecs.map((s) => ({
    header: s.header,
    key: s.key,
    width: 22,
    headerTone: 'erp'
  }));

  const headSys = filterColumnDefsByExport(SYSTEM_COLS_HEAD, opts);
  const tailSys = filterColumnDefsByExport(SYSTEM_COLS_TAIL, opts);
  const headWb = filterColumnDefsByExport(WB_COLS_HEAD, opts);
  const tailWb = filterColumnDefsByExport(WB_COLS_TAIL, opts);
  const headOzon = filterColumnDefsByExport(OZON_COLS_HEAD, opts);
  const tailOzon = filterColumnDefsByExport(OZON_COLS_TAIL, opts);
  const headYm = filterColumnDefsByExport(YM_COLS_HEAD, opts);
  const tailYm = filterColumnDefsByExport(YM_COLS_TAIL, opts);

  const colDefs = [
    ...headSys,
    ...tailSys,
    ...erpDynamicCols,
    ...headWb,
    ...wbDynamicCols,
    ...tailWb,
    ...headOzon,
    ...ozDynamicCols,
    ...tailOzon,
    ...headYm,
    ...ymDynamicCols,
    ...tailYm
  ];
  return { colDefs, dynamicSpecs, erpDynamicSpecs };
}

/**
 * Блок на листе «Словари» под строками ERP: атрибуты МП из cache_entries (mp_attributes) + значения из выгрузки.
 */
function appendMpMarketplaceDictionaryBlock(ws, startRow, products, mpAttributeCaches) {
  const valueAgg = buildMpAttrValueAggregate(products);
  const emitted = new Set();

  let r = startRow;
  try {
    ws.mergeCells(r, 1, r, 6);
  } catch {
    /* ignore */
  }
  const titleCell = ws.getCell(r, 1);
  titleCell.value =
    'Атрибуты маркетплейсов: схема из кэша API (открывали карточки/категории в ERP) + уникальные значения из этой выгрузки';
  titleCell.font = { bold: true };
  titleCell.alignment = { wrapText: true, vertical: 'middle' };
  r += 1;

  const hdr = [
    'Маркетплейс',
    'Ключ кэша (категория API)',
    'ID атрибута',
    'Название',
    'Тип / варианты (справочник)',
    'Значения из выгрузки (уникальные)'
  ];
  hdr.forEach((h, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = h;
    c.font = { bold: true };
  });
  r += 1;

  const caches = Array.isArray(mpAttributeCaches) ? mpAttributeCaches : [];

  for (const entry of caches) {
    const cacheKey = entry.cache_key != null ? String(entry.cache_key) : '';
    const raw = parseCacheValueCell(entry.cache_value);
    if (!cacheKey || raw == null) continue;

    if (cacheKey.startsWith('ozon:')) {
      for (const a of parseOzonSchemaFromCache(raw)) {
        const idStr = String(a.id);
        const aggKey = `Ozon|${idStr}`;
        emitted.add(aggKey);
        const vs = valueAgg.get(aggKey);
        ws.getCell(r, 1).value = 'Ozon';
        ws.getCell(r, 2).value = cacheKey;
        ws.getCell(r, 3).value = Number.isFinite(Number(idStr)) ? Number(idStr) : idStr;
        ws.getCell(r, 4).value = a.name;
        ws.getCell(r, 5).value = ozonTypeHint(a);
        ws.getCell(r, 6).value = vs ? clampText([...vs].join('; '), 12000) : '';
        r += 1;
      }
    } else if (cacheKey.startsWith('wb:')) {
      for (const a of parseWbSchemaFromCache(raw)) {
        const idStr = String(a.id);
        const aggKey = `Wildberries|${idStr}`;
        emitted.add(aggKey);
        const vs = valueAgg.get(aggKey);
        ws.getCell(r, 1).value = 'Wildberries';
        ws.getCell(r, 2).value = cacheKey;
        ws.getCell(r, 3).value = Number.isFinite(Number(idStr)) ? Number(idStr) : idStr;
        ws.getCell(r, 4).value = a.name;
        ws.getCell(r, 5).value = a.type ? String(a.type) : '—';
        ws.getCell(r, 6).value = vs ? clampText([...vs].join('; '), 12000) : '';
        r += 1;
      }
    } else if (cacheKey.startsWith('ym:')) {
      for (const a of parseYmSchemaFromCache(raw)) {
        const idStr = String(a.id);
        const aggKey = `Яндекс.Маркет|${idStr}`;
        emitted.add(aggKey);
        const vs = valueAgg.get(aggKey);
        ws.getCell(r, 1).value = 'Яндекс.Маркет';
        ws.getCell(r, 2).value = cacheKey;
        ws.getCell(r, 3).value = Number.isFinite(Number(idStr)) ? Number(idStr) : idStr;
        ws.getCell(r, 4).value = a.name;
        ws.getCell(r, 5).value = a.hint;
        ws.getCell(r, 6).value = vs ? clampText([...vs].join('; '), 12000) : '';
        r += 1;
      }
    }
  }

  for (const [aggKey, set] of valueAgg.entries()) {
    if (emitted.has(aggKey)) continue;
    const parts = aggKey.split('|');
    const mp = parts[0] || '';
    const idPart = parts[1] || '';
    const namePart = parts[2] || '';
    ws.getCell(r, 1).value = mp;
    ws.getCell(r, 2).value = '— только из выгрузки (нет схемы в кэше) —';
    ws.getCell(r, 3).value = idPart && idPart !== '_' ? (Number.isFinite(Number(idPart)) ? Number(idPart) : idPart) : '';
    ws.getCell(r, 4).value = namePart && namePart !== '_' ? namePart : '';
    ws.getCell(r, 5).value = '—';
    ws.getCell(r, 6).value = clampText([...set].join('; '), 12000);
    r += 1;
  }

  ws.getColumn(5).width = Math.max(ws.getColumn(5).width || 0, 40);
  ws.getColumn(6).width = Math.max(ws.getColumn(6).width || 0, 52);
  return r;
}

function mpLabelFromMarketplace(marketplace) {
  if (marketplace === 'ozon') return 'Ozon';
  if (marketplace === 'wb') return 'Wildberries';
  if (marketplace === 'ym') return 'Яндекс.Маркет';
  return '';
}

function aggKeysForDynamicSpec(spec, mpLabel) {
  const keys = [];
  if (spec.attrId != null && String(spec.attrId).trim() !== '') {
    keys.push(`${mpLabel}|${String(spec.attrId).trim()}`);
  }
  const nm = (spec.attrName && String(spec.attrName).trim()) || '';
  if (nm) keys.push(`${mpLabel}||${nm}`);
  return keys;
}

function buildWbCharcAllowedStringsById(mpAttributeCaches) {
  const m = new Map();
  for (const entry of mpAttributeCaches || []) {
    if (!String(entry.cache_key || '').startsWith('wb:')) continue;
    const raw = parseCacheValueCell(entry.cache_value);
    for (const a of parseWbSchemaFromCache(raw)) {
      if (!a.allowedList || !a.allowedList.length) continue;
      const idStr = String(a.id);
      const prev = m.get(idStr) || [];
      m.set(idStr, [...new Set([...prev, ...a.allowedList])]);
    }
  }
  return m;
}

function buildYmDictionaryOptionsByParamId(mpAttributeCaches) {
  const m = new Map();
  for (const entry of mpAttributeCaches || []) {
    if (!String(entry.cache_key || '').startsWith('ym:')) continue;
    const raw = parseCacheValueCell(entry.cache_value);
    for (const a of parseYmSchemaFromCache(raw)) {
      if (!a.dictionary_options || !a.dictionary_options.length) continue;
      const id = String(a.id);
      const prev = m.get(id) || [];
      m.set(id, prev.concat(a.dictionary_options));
    }
  }
  return m;
}

/** Ключ кэша: ozon:attributeId:description_category_id:type_id:limit=100 */
function parseOzonDictCacheKey(cacheKey) {
  const s = String(cacheKey || '');
  const m = s.match(/^ozon:(\d+):(\d+):(\d+):limit=\d+$/);
  if (!m) return null;
  return { attrId: m[1], descId: m[2], typeId: m[3] };
}

/**
 * Подпись для Excel: API часто отдаёт value уже как «41569 — Графитное покрытие»;
 * из выгрузки попадают голые id — их в список не включаем.
 */
function ozonDropdownLabelOnly(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  const compound = t.match(/^\d+\s*[—–-]\s*(.+)$/);
  if (compound) return compound[1].trim();
  if (/^\d+$/.test(t)) return '';
  return t;
}

/** Только подпись для выпадающего списка (без id и без «id — текст»). */
function ozonDictItemToStrings(x) {
  if (x == null) return [];
  if (typeof x === 'string' || typeof x === 'number') {
    const s = ozonDropdownLabelOnly(String(x).trim());
    return s ? [s] : [];
  }
  if (typeof x !== 'object') return [];
  const vs =
    x.value != null
      ? String(x.value).trim()
      : x.info != null
        ? String(x.info).trim()
        : x.title != null
          ? String(x.title).trim()
          : '';
  const s = ozonDropdownLabelOnly(vs);
  return s ? [s] : [];
}

/** Справочник значений Ozon из кэша mp_dict_values (ответ API attribute/values). */
function buildOzonDictionaryStringsByAttrId(mpDictValueCaches) {
  const m = new Map();
  for (const entry of mpDictValueCaches || []) {
    const parsed = parseOzonDictCacheKey(entry.cache_key);
    if (!parsed) continue;
    const raw = parseCacheValueCell(entry.cache_value);
    const items = Array.isArray(raw?.result) ? raw.result : Array.isArray(raw) ? raw : [];
    const attrKey = String(parsed.attrId);
    const prev = new Set(m.get(attrKey) || []);
    for (const it of items) {
      for (const s of ozonDictItemToStrings(it)) {
        if (s) prev.add(s);
      }
    }
    m.set(attrKey, prev);
  }
  const out = new Map();
  for (const [k, set] of m) {
    const labels = [...new Set([...set].map((s) => ozonDropdownLabelOnly(s)).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'ru')
    );
    out.set(k, labels);
  }
  return out;
}

function buildOzonSchemaAllowedStringsByAttrId(mpAttributeCaches) {
  const m = new Map();
  for (const entry of mpAttributeCaches || []) {
    if (!String(entry.cache_key || '').startsWith('ozon:')) continue;
    const raw = parseCacheValueCell(entry.cache_value);
    for (const a of parseOzonSchemaFromCache(raw)) {
      if (!a.allowedList || !a.allowedList.length) continue;
      const idStr = String(a.id);
      const prev = m.get(idStr) || [];
      m.set(idStr, [...new Set([...prev, ...a.allowedList])]);
    }
  }
  return m;
}

function collectStringsForDynamicSpec(
  spec,
  valueAgg,
  wbAllowedMap,
  ymOptionsMap,
  ozonDictByAttrId,
  ozonSchemaAllowedByAttrId
) {
  const set = new Set();
  const mp = mpLabelFromMarketplace(spec.marketplace);
  if (!mp) return [];
  for (const aggKey of aggKeysForDynamicSpec(spec, mp)) {
    const vs = valueAgg.get(aggKey);
    if (!vs) continue;
    for (const v of vs) {
      const t = String(v != null ? formatScalar(v) : '').trim();
      if (t) set.add(t);
    }
  }
  const idStr = spec.attrId != null ? String(spec.attrId).trim() : '';
  if (spec.marketplace === 'ozon' && idStr) {
    const fromDict = ozonDictByAttrId?.get(idStr);
    if (fromDict) fromDict.forEach((s) => set.add(String(s).trim()));
    const fromSchema = ozonSchemaAllowedByAttrId?.get(idStr);
    if (fromSchema) fromSchema.forEach((s) => set.add(String(s).trim()));
  }
  if (spec.marketplace === 'wb' && idStr && wbAllowedMap) {
    const arr = wbAllowedMap.get(idStr);
    if (arr) arr.forEach((s) => set.add(String(s).trim()));
  }
  if (spec.marketplace === 'ym' && idStr && ymOptionsMap) {
    const opts = ymOptionsMap.get(idStr);
    if (opts) {
      for (const o of opts) {
        const label = o.label != null ? String(o.label).trim() : '';
        if (label) set.add(label);
      }
    }
  }
  if (spec.marketplace === 'ozon') {
    const list = [
      ...new Set(
        [...set]
          .map((s) => ozonDropdownLabelOnly(String(s).trim()))
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b, 'ru'));
    return list.slice(0, 500);
  }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')).slice(0, 500);
}

/**
 * Колонка H: варианты для выпадающих списков по динамическим столбцам характеристик МП.
 * @returns {Record<string, string>}
 */
function appendMpProductColumnDropdownLists(ws, startRow, dynamicSpecs, products, mpAttributeCaches, mpDictValueCaches) {
  const formulae = {};
  if (!Array.isArray(dynamicSpecs) || dynamicSpecs.length === 0) return formulae;

  const valueAgg = buildMpAttrValueAggregate(products);
  const wbAllowed = buildWbCharcAllowedStringsById(mpAttributeCaches);
  const ymOpts = buildYmDictionaryOptionsByParamId(mpAttributeCaches);
  const ozonDict = buildOzonDictionaryStringsByAttrId(mpDictValueCaches);
  const ozonSchemaAllowed = buildOzonSchemaAllowedStringsByAttrId(mpAttributeCaches);

  let r = startRow;
  try {
    ws.mergeCells(r, 8, r, 10);
  } catch {
    /* ignore */
  }
  const titleCell = ws.getCell(r, 8);
  titleCell.value =
    'Варианты для списков по столбцам характеристик МП (лист «Товары»): колонка H — по одному значению в строке (выгрузка + кэш mp_attributes / mp_dict_values Ozon, ENUM WB/Яндекс).';
  titleCell.font = { bold: true, italic: true };
  titleCell.alignment = { wrapText: true, vertical: 'middle' };
  r += 2;

  const COL_LETTER = 'H';
  const MAX_TOTAL_ROWS = 12000;
  let usedRows = 0;

  for (const spec of dynamicSpecs) {
    const list = collectStringsForDynamicSpec(spec, valueAgg, wbAllowed, ymOpts, ozonDict, ozonSchemaAllowed);
    if (list.length === 0) continue;
    const room = MAX_TOTAL_ROWS - usedRows;
    if (room < 1) break;
    const take = Math.min(list.length, room, 500);
    const slice = list.slice(0, take);
    const startData = r;
    for (const v of slice) {
      ws.getCell(r, 8).value = v;
      r += 1;
      usedRows += 1;
    }
    formulae[spec.key] = columnRangeFormula(DICT_SHEET_NAME, COL_LETTER, startData, take);
    r += 1;
  }

  ws.getColumn(8).width = Math.max(ws.getColumn(8).width || 0, 44);
  return formulae;
}

function rowsToDetailCell(rows) {
  if (!rows.length) return '';
  const lines = rows
    .filter((r) => r && (r.value !== '' || r.attribute_name))
    .map((r) => {
      const hasName = r.attribute_name && String(r.attribute_name).trim() !== '';
      const hasId = r.attribute_id && String(r.attribute_id).trim() !== '';
      const label = hasName ? String(r.attribute_name).trim() : hasId ? `id ${r.attribute_id}` : '—';
      return `${label}: ${r.value}`;
    });
  return clampText(lines.join('\n'));
}

function cellOzonDetail(p) {
  return rowsToDetailCell(normalizeOzonToRows(getMergedOzonRaw(p)));
}

function cellWbDetail(p) {
  return rowsToDetailCell(normalizeWbToRows(getMergedWbRaw(p)));
}

function cellYmDetail(p) {
  return rowsToDetailCell(normalizeYmToRows(getMergedYmRaw(p)));
}

function cellImagesDetail(p) {
  const img = parseJsonb(mpField(p, 'images', 'productImages'));
  if (!img) return '';
  if (Array.isArray(img)) {
    const urls = img
      .map((x) => {
        if (typeof x === 'string') return x.trim();
        if (x && typeof x === 'object') return String(x.url ?? x.href ?? x.src ?? '').trim();
        return '';
      })
      .filter(Boolean);
    return clampText(urls.join('\n'));
  }
  if (typeof img === 'object') {
    const u = img.url ?? img.href;
    if (u) return String(u);
  }
  return '';
}

/** Публичный базовый URL API для абсолютных ссылок в Excel (импорт по URL). */
function publicApiBaseForExport() {
  return String(process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '').replace(/\/$/, '');
}

function absoluteImageUrlForExport(relativeOrAbsolute) {
  const u = String(relativeOrAbsolute || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const base = publicApiBaseForExport();
  if (!base) return u;
  return u.startsWith('/') ? `${base}${u}` : `${base}/${u}`;
}

/** Колонки «главное фото» и «остальные через ;» для импорта по ссылкам. */
function splitProductImagesForExportColumns(p) {
  const img = parseJsonb(mpField(p, 'images', 'productImages'));
  if (!Array.isArray(img) || img.length === 0) {
    return { image_main_url: '', image_gallery_urls: '' };
  }
  const entries = img
    .map((x) => {
      if (typeof x === 'string') return { url: x.trim(), primary: false };
      if (x && typeof x === 'object') {
        return {
          url: String(x.url ?? x.href ?? x.src ?? '').trim(),
          primary: x.primary === true
        };
      }
      return { url: '', primary: false };
    })
    .filter((e) => e.url);
  if (entries.length === 0) return { image_main_url: '', image_gallery_urls: '' };
  let idxPrimary = entries.findIndex((e) => e.primary);
  if (idxPrimary < 0) idxPrimary = 0;
  const mainEntry = entries[idxPrimary];
  const others = entries.filter((_, i) => i !== idxPrimary);
  return {
    image_main_url: toCell(absoluteImageUrlForExport(mainEntry.url)),
    image_gallery_urls: clampText(others.map((e) => absoluteImageUrlForExport(e.url)).join('; '))
  };
}

/** Значение для ячейки Excel (BigInt/NaN/сырые объекты) */
function toExcelCellValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : String(v);
  }
  if (typeof v === 'number' && (Number.isNaN(v) || !Number.isFinite(v))) return '';
  if (typeof v === 'object' && v !== null && !(v instanceof Date)) {
    try {
      const s = JSON.stringify(v);
      return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 30)}…[обрезано]` : s;
    } catch {
      return String(v);
    }
  }
  return v;
}

/** Одна строка товара как объект по ключам колонок */
function productToRowObject(p) {
  const imageCols = splitProductImagesForExportColumns(p);
  const barcodes = Array.isArray(p.barcodes) ? p.barcodes.filter(Boolean).join('; ') : '';
  const idRaw = p.id;
  const idCell =
    idRaw != null && idRaw !== ''
      ? typeof idRaw === 'bigint'
        ? Number(idRaw)
        : idRaw
      : '';
  return {
    id: idCell,
    sku: toCell(p.sku),
    name: toCell(p.name),
    brand: toCell(p.brand ?? p.brand_name),
    category_name: toCell(p.category_name),
    organization_name: toCell(p.organization_name),
    product_type: toCell(p.product_type),
    country_of_origin: toCell(p.country_of_origin),
    description: toCell(p.description),
    cost: p.cost != null && p.cost !== '' ? Number(p.cost) : '',
    additional_expenses:
      p.additional_expenses != null && p.additional_expenses !== ''
        ? Number(p.additional_expenses)
        : p.additionalExpenses != null
          ? Number(p.additionalExpenses)
          : '',
    min_price:
      p.min_price != null && p.min_price !== ''
        ? Number(p.min_price)
        : p.minPrice != null
          ? Number(p.minPrice)
          : '',
    quantity: p.quantity != null ? Number(p.quantity) : '',
    weight: p.weight != null && p.weight !== '' ? Number(p.weight) : '',
    length: p.length != null && p.length !== '' ? Number(p.length) : '',
    width: p.width != null && p.width !== '' ? Number(p.width) : '',
    height: p.height != null && p.height !== '' ? Number(p.height) : '',
    barcodes: toCell(barcodes),
    sku_ozon: toCell(p.sku_ozon),
    sku_wb: toCell(p.sku_wb),
    sku_ym: toCell(p.sku_ym),
    ozon_product_id: p.ozon_product_id != null ? Number(p.ozon_product_id) : '',
    buyout_rate: p.buyout_rate != null ? Number(p.buyout_rate) : '',
    buyout_rate_ozon: p.buyout_rate_ozon != null ? Number(p.buyout_rate_ozon) : '',
    buyout_rate_wb: p.buyout_rate_wb != null ? Number(p.buyout_rate_wb) : '',
    buyout_rate_ym: p.buyout_rate_ym != null ? Number(p.buyout_rate_ym) : '',
    stored_min_ozon: p.storedMinPriceOzon != null ? Number(p.storedMinPriceOzon) : '',
    stored_min_wb: p.storedMinPriceWb != null ? Number(p.storedMinPriceWb) : '',
    stored_min_ym: p.storedMinPriceYm != null ? Number(p.storedMinPriceYm) : '',
    wb_vendor_sku: toCell(p.mp_wb_vendor_code),
    wb_name: toCell(p.mp_wb_name),
    wb_brand: toCell(p.mp_wb_brand),
    wb_description: toCell(p.mp_wb_description),
    ym_name: toCell(p.mp_ym_name),
    ym_description: toCell(p.mp_ym_description),
    ozon_attributes_detail: cellOzonDetail(p),
    wb_attributes_detail: cellWbDetail(p),
    ym_attributes_detail: cellYmDetail(p),
    images_detail: cellImagesDetail(p),
    image_main_url: imageCols.image_main_url,
    image_gallery_urls: imageCols.image_gallery_urls
  };
}

const DETAIL_KEYS = new Set([
  'ozon_attributes_detail',
  'wb_attributes_detail',
  'ym_attributes_detail',
  'images_detail',
  'image_gallery_urls'
]);

/** До блока «по одному столбцу на характеристику МП». headerTone — цвет заголовка (синий / фиолетовый / жёлтый). */
/** Системные колонки (без МП), затем блоки WB → Ozon → YM собираются в buildProductSheetColumns */
const SYSTEM_COLS_HEAD = [
  { header: 'ID', key: 'id', width: 10 },
  { header: 'Артикул', key: 'sku', width: 18 },
  { header: 'Название', key: 'name', width: 36 },
  { header: '% выкупа (общий)', key: 'buyout_rate', width: 12 }
];

const WB_COLS_HEAD = [
  { header: 'Артикул', key: 'sku_wb', width: 16, headerTone: 'wb' },
  { header: 'Артикул продавца (WB)', key: 'wb_vendor_sku', width: 20, headerTone: 'wb' },
  { header: 'Название (WB)', key: 'wb_name', width: 36, headerTone: 'wb' },
  { header: 'Бренд (WB)', key: 'wb_brand', width: 18, headerTone: 'wb' },
  { header: 'Описание (WB)', key: 'wb_description', width: 40, headerTone: 'wb' },
  { header: '% выкупа', key: 'buyout_rate_wb', width: 12, headerTone: 'wb' },
  { header: 'Сохр. мин. цена', key: 'stored_min_wb', width: 16, headerTone: 'wb' }
];

const OZON_COLS_HEAD = [
  { header: 'Артикул', key: 'sku_ozon', width: 16, headerTone: 'ozon' },
  { header: 'ID в каталоге', key: 'ozon_product_id', width: 14, headerTone: 'ozon' },
  { header: '% выкупа', key: 'buyout_rate_ozon', width: 12, headerTone: 'ozon' },
  { header: 'Сохр. мин. цена', key: 'stored_min_ozon', width: 16, headerTone: 'ozon' }
];

const YM_COLS_HEAD = [
  { header: 'Артикул', key: 'sku_ym', width: 16, headerTone: 'ym' },
  { header: 'Название (Яндекс)', key: 'ym_name', width: 36, headerTone: 'ym' },
  { header: 'Описание (Яндекс)', key: 'ym_description', width: 40, headerTone: 'ym' },
  { header: '% выкупа', key: 'buyout_rate_ym', width: 12, headerTone: 'ym' },
  { header: 'Сохр. мин. цена', key: 'stored_min_ym', width: 18, headerTone: 'ym' }
];

const SYSTEM_COLS_TAIL = [
  { header: 'Изображения (ссылки)', key: 'images_detail', width: 44 },
  { header: 'Ссылка на главное фото', key: 'image_main_url', width: 44 },
  { header: 'Ссылки на фото через ;', key: 'image_gallery_urls', width: 48 },
  { header: 'Бренд', key: 'brand', width: 18 },
  { header: 'Категория', key: 'category_name', width: 28 },
  { header: 'Организация', key: 'organization_name', width: 24 },
  { header: 'Тип товара', key: 'product_type', width: 12 },
  { header: 'Страна производства', key: 'country_of_origin', width: 22 },
  { header: 'Описание', key: 'description', width: 40 },
  { header: 'Себестоимость', key: 'cost', width: 14 },
  { header: 'Доп. расходы', key: 'additional_expenses', width: 14 },
  { header: 'Мин. цена', key: 'min_price', width: 12 },
  { header: 'Количество', key: 'quantity', width: 12 },
  { header: 'Вес (г)', key: 'weight', width: 10 },
  { header: 'Длина', key: 'length', width: 10 },
  { header: 'Ширина', key: 'width', width: 10 },
  { header: 'Высота', key: 'height', width: 10 },
  { header: 'Штрихкоды', key: 'barcodes', width: 28 }
];

/** Раньше: отдельная колонка «Характеристики (текст)»; убрана из шаблона — дублирует динамические столбцы mpdyn_* */
const WB_COLS_TAIL = [];
const OZON_COLS_TAIL = [];
const YM_COLS_TAIL = [];

function applyDetailColumnWrap(ws, colDefs) {
  colDefs.forEach((c, i) => {
    if (
      DETAIL_KEYS.has(c.key) ||
      (typeof c.key === 'string' && (c.key.startsWith('mpdyn_') || c.key.startsWith('erpdyn_')))
    ) {
      const col = ws.getColumn(i + 1);
      col.alignment = { wrapText: true, vertical: 'top' };
    }
  });
}

/**
 * @param {{ forceHeaderAutoFilter?: boolean }} [sheetOpts] — для пустого шаблона: автофильтр по строке заголовков
 */
function fillSheet(ws, colDefs, products, dynamicSpecs = [], sheetOpts = {}, mpResolveCtx = null, erpDynamicSpecs = []) {
  // Явная запись по номеру колонки: addRow([...]) в ExcelJS пропускает undefined,
  // но индекс колонки всё равно сдвигается — из‑за этого часть столбцов «съезжала» или оставалась пустой.
  // Не передаём key в columns: ключи вроде width/height/name совпадают с API Column и ломают порядок/привязку в ExcelJS.
  ws.columns = colDefs.map((c) => ({ width: c.width }));

  const headerRow = ws.getRow(1);
  colDefs.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    if (c.headerTone) {
      applyMarketplaceHeaderCellStyle(cell, c.headerTone);
    } else {
      cell.font = { bold: true };
      cell.alignment = { vertical: 'middle', wrapText: true };
    }
  });

  // Строка 2 — технические ключи колонок (скрыта). Нужна для импорта при повторяющихся заголовках («Артикул» и т.д.).
  const keyRow = ws.getRow(2);
  colDefs.forEach((c, i) => {
    keyRow.getCell(i + 1).value = String(c.key || '');
  });
  keyRow.hidden = true;

  products.forEach((p, ri) => {
    const maps = dynamicSpecs.length > 0 ? buildMpAttrLookupMaps(p) : null;
    const dataRow = ws.getRow(ri + 3);
    const rowObj = productToRowObject(p);
    if (maps && dynamicSpecs.length > 0) {
      for (const spec of dynamicSpecs) {
        const rawVal = pickDynamicValueFromMaps(maps, spec);
        const displayVal = mpResolveCtx ? resolveDynamicDisplayValue(spec, rawVal, mpResolveCtx) : rawVal;
        rowObj[spec.key] = toCell(displayVal);
      }
    }
    if (erpDynamicSpecs && erpDynamicSpecs.length > 0) {
      const av =
        p.attribute_values && typeof p.attribute_values === 'object' && !Array.isArray(p.attribute_values)
          ? p.attribute_values
          : {};
      for (const spec of erpDynamicSpecs) {
        const rawVal = av[spec.attrId];
        rowObj[spec.key] = rawVal !== undefined && rawVal !== null ? toCell(formatScalar(rawVal)) : '';
      }
    }
    colDefs.forEach((c, i) => {
      let v = rowObj[c.key];
      if (v === undefined || v === null) v = '';
      dataRow.getCell(i + 1).value = toExcelCellValue(v);
    });
  });

  applyDetailColumnWrap(ws, colDefs);
  if (products.length > 0 || sheetOpts.forceHeaderAutoFilter === true) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: colDefs.length }
    };
  }
}

/** Экранирование имени листа для формул Excel */
function escapeSheetNameForFormula(name) {
  return String(name).replace(/'/g, "''");
}

/** Диапазон столбца для проверки данных: 'Лист'!$A$2:$A$10 */
function columnRangeFormula(sheetName, colLetter, startRow, itemCount) {
  const esc = escapeSheetNameForFormula(sheetName);
  if (!itemCount || itemCount < 1) {
    return `'${esc}'!$${colLetter}$${startRow}:$${colLetter}$${startRow}`;
  }
  const endRow = startRow + itemCount - 1;
  return `'${esc}'!$${colLetter}$${startRow}:$${colLetter}$${endRow}`;
}

/** Excel часто ожидает в formula1 списка ведущий «=»; без него проверка может не сработать. */
function excelListValidationFormula(rangeRef) {
  if (rangeRef == null || rangeRef === '') return rangeRef;
  const t = String(rangeRef).trim();
  if (!t) return t;
  return t.startsWith('=') ? t : `=${t}`;
}

/**
 * Лист «Словари»: A–G — категории, организации, бренды, типы товара (+ id для справки).
 * Ниже — блок атрибутов маркетплейсов (кэш mp_attributes + значения из выгрузки).
 * @returns {{ categoryNamesFormula: string, orgNamesFormula: string, brandNamesFormula: string, productTypeFormula: string, mpDropdownFormulaeByKey: Record<string, string> }}
 */
function fillDictionarySheet(ws, dictionaries, products = [], dynamicSpecs = []) {
  const row1 = ws.getRow(1);
  const headers = [
    'Категория (название)',
    'ID категории',
    'Организация',
    'ID организации',
    'Бренд',
    'Тип товара (код в БД)',
    'Тип (пояснение)'
  ];
  headers.forEach((h, i) => {
    row1.getCell(i + 1).value = h;
  });
  row1.font = { bold: true };
  row1.alignment = { vertical: 'middle', wrapText: true };

  const cats = Array.isArray(dictionaries.categories) ? dictionaries.categories : [];
  cats.forEach((c, i) => {
    const r = i + 2;
    ws.getCell(r, 1).value = c.name != null ? String(c.name) : '';
    ws.getCell(r, 2).value = c.id != null ? Number(c.id) : '';
  });

  const orgs = Array.isArray(dictionaries.organizations) ? dictionaries.organizations : [];
  orgs.forEach((o, i) => {
    const r = i + 2;
    ws.getCell(r, 3).value = o.name != null ? String(o.name) : '';
    ws.getCell(r, 4).value = o.id != null ? Number(o.id) : '';
  });

  const brands = Array.isArray(dictionaries.brands) ? dictionaries.brands : [];
  brands.forEach((name, i) => {
    ws.getCell(i + 2, 5).value = name != null ? String(name) : '';
  });

  const types = Array.isArray(dictionaries.productTypes) ? dictionaries.productTypes : [];
  types.forEach((t, i) => {
    const r = i + 2;
    ws.getCell(r, 6).value = t.code != null ? String(t.code) : '';
    ws.getCell(r, 7).value = t.label != null ? String(t.label) : '';
  });

  [32, 12, 32, 12, 26, 22, 16].forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const maxErpLen = Math.max(cats.length, orgs.length, brands.length, types.length, 0);
  const erpEndRow = maxErpLen === 0 ? 1 : 1 + maxErpLen;
  const mpBlockEndRow = appendMpMarketplaceDictionaryBlock(
    ws,
    erpEndRow + 2,
    products,
    dictionaries.mpAttributeCaches || []
  );
  const mpDropdownFormulaeByKey = appendMpProductColumnDropdownLists(
    ws,
    mpBlockEndRow + 2,
    dynamicSpecs,
    products,
    dictionaries.mpAttributeCaches || [],
    dictionaries.mpDictValueCaches || []
  );

  return {
    categoryNamesFormula: columnRangeFormula(DICT_SHEET_NAME, 'A', 2, cats.length),
    orgNamesFormula: columnRangeFormula(DICT_SHEET_NAME, 'C', 2, orgs.length),
    brandNamesFormula: columnRangeFormula(DICT_SHEET_NAME, 'E', 2, brands.length),
    productTypeFormula: columnRangeFormula(DICT_SHEET_NAME, 'F', 2, types.length),
    mpDropdownFormulaeByKey
  };
}

function colNumberByKey(colDefs, key) {
  const idx = colDefs.findIndex((c) => c.key === key);
  return idx >= 0 ? idx + 1 : 0;
}

/**
 * Проверка данных: выпадающий список на строках товаров (не на заголовке).
 */
function applyDropdownValidations(ws, colDefs, productRowCount, formulae) {
  if (productRowCount < 1) return;

  const rowStart = 3;
  const rowEnd = 2 + productRowCount;

  const applyCol = (key, formula, promptTitle, prompt) => {
    const col = colNumberByKey(colDefs, key);
    if (!col || !formula) return;
    const dv = {
      type: 'list',
      allowBlank: true,
      formulae: [excelListValidationFormula(formula)],
      showInputMessage: true,
      promptTitle: promptTitle || '',
      prompt: prompt || 'Выберите значение из списка на листе «Словари».',
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: 'Нет в списке',
      error: 'Значение не из справочника. Можно оставить пустым или выбрать из списка.'
    };
    for (let r = rowStart; r <= rowEnd; r++) {
      ws.getCell(r, col).dataValidation = { ...dv };
    }
  };

  applyCol('category_name', formulae.categoryNamesFormula, 'Категория', 'Список категорий ERP (колонка A на листе «Словари»).');
  applyCol('organization_name', formulae.orgNamesFormula, 'Организация', 'Список организаций (колонка C).');
  applyCol('brand', formulae.brandNamesFormula, 'Бренд', 'Список брендов (колонка E).');
  applyCol('product_type', formulae.productTypeFormula, 'Тип товара', 'product = товар, kit = комплект (колонка F).');
}

/** Выпадающие списки для динамических столбцов характеристик МП (ключи mpdyn_*). */
function applyMpDynamicDropdownValidations(ws, colDefs, productRowCount, mpDropdownFormulaeByKey) {
  if (productRowCount < 1 || !mpDropdownFormulaeByKey || typeof mpDropdownFormulaeByKey !== 'object') return;

  const rowStart = 3;
  const rowEnd = 2 + productRowCount;

  for (const [key, formula] of Object.entries(mpDropdownFormulaeByKey)) {
    if (!formula) continue;
    const col = colNumberByKey(colDefs, key);
    if (!col) continue;
    const dv = {
      type: 'list',
      allowBlank: true,
      formulae: [excelListValidationFormula(formula)],
      showInputMessage: true,
      promptTitle: 'Атрибут МП',
      prompt: 'Выберите значение из списка (лист «Словари», колонка H) или введите своё.',
      showErrorMessage: true,
      errorStyle: 'warning',
      errorTitle: 'Нет в списке',
      error: 'Можно оставить пустым или ввести значение вручную.'
    };
    for (let r = rowStart; r <= rowEnd; r++) {
      ws.getCell(r, col).dataValidation = { ...dv };
    }
  }
}

/**
 * @param {object[]} products
 * @param {object} [dictionaries] — категории, организации, бренды, единицы, типы (см. products.service exportToExcel)
 * @param {{ forceHeaderAutoFilter?: boolean, minDropdownDataRows?: number }} [sheetOpts] — пустой шаблон: автофильтр и проверка данных на N строк (словари)
 * @returns {Promise<Buffer>}
 */
export async function buildProductsExcelBuffer(products, dictionaries = null, exportOptions = {}, sheetOpts = {}) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  wb.creator = 'ERP';

  const dictPayload = dictionaries || {
    categories: [],
    organizations: [],
    brands: [],
    productTypes: [
      { code: 'product', label: 'Товар' },
      { code: 'kit', label: 'Комплект' }
    ],
    mpAttributeCaches: [],
    mpDictValueCaches: [],
    categoryMappingsById: {},
    exportTemplateCategoryId: null
  };

  const exportOpts = normalizeProductExportOptions(exportOptions);
  const scope = buildMpAttributeCacheScope(
    products,
    dictPayload.categoryMappingsById || null,
    dictPayload.exportTemplateCategoryId != null && String(dictPayload.exportTemplateCategoryId).trim() !== ''
      ? dictPayload.exportTemplateCategoryId
      : null,
    dictPayload.flatOzonCategories || null
  );
  const filteredCaches = filterMpAttributeCachesByCategoryScope(
    filterMpCachesForExport(dictPayload.mpAttributeCaches || [], exportOpts),
    scope
  );
  const filteredDictValCaches = filterMpDictValueCachesForOzonCategoryScope(
    filterMpDictValueCachesForExport(dictPayload.mpDictValueCaches || [], exportOpts),
    scope.ozonKeys
  );
  const dictForSheet = { ...dictPayload, mpAttributeCaches: filteredCaches, mpDictValueCaches: filteredDictValCaches };

  const { colDefs, dynamicSpecs, erpDynamicSpecs } = buildProductSheetColumns(products, filteredCaches, exportOpts);

  const mpResolveCtx =
    dynamicSpecs.length > 0
      ? {
          wbValueIdToLabel: buildWbCharcValueIdToLabelByCharcId(filteredCaches),
          ozonValueIdToLabel: buildOzonValueIdToLabelByAttrId(filteredDictValCaches),
          ymValueIdToLabel: buildYmValueIdToLabelByParamId(filteredCaches)
        }
      : null;

  /** Не только по числу товаров: иначе стрелка списка есть только в первых N строках; новые строки без выпадающего списка. */
  const MP_DROPDOWN_MIN_ROWS = 2000;
  const minDrop = Number(sheetOpts.minDropdownDataRows);
  const dropdownRowCount = Math.max(
    products.length,
    Number.isFinite(minDrop) && minDrop > 0 ? minDrop : 0,
    dynamicSpecs.length > 0 ? MP_DROPDOWN_MIN_ROWS : 0
  );

  const wsProducts = wb.addWorksheet('Товары', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  fillSheet(wsProducts, colDefs, products, dynamicSpecs, sheetOpts, mpResolveCtx, erpDynamicSpecs);

  const wsDict = wb.addWorksheet(DICT_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  const formulae = fillDictionarySheet(wsDict, dictForSheet, products, dynamicSpecs);

  wsDict.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  if (
    (dictPayload.categories && dictPayload.categories.length > 0) ||
    (dictPayload.organizations && dictPayload.organizations.length > 0) ||
    (dictPayload.brands && dictPayload.brands.length > 0)
  ) {
    wsDict.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: 7 }
    };
  }

  applyDropdownValidations(wsProducts, colDefs, dropdownRowCount, formulae);
  applyMpDynamicDropdownValidations(wsProducts, colDefs, dropdownRowCount, formulae.mpDropdownFormulaeByKey);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
