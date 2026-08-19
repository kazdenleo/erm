/**
 * Выгрузка данных карточки товара ERP на маркетплейсы (Ozon, WB, Яндекс.Маркет).
 */

import integrationsService from './integrations.service.js';
import productsService from './products.service.js';
import {
  parseUserCategoryMarketplaceMappings,
  extractOzonDescTypeForCache
} from './productsExport.service.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import {
  gramsToKg,
  overlayCategoryDedicatedMpLinks,
  isMpFieldLinked,
  mmToCm,
  normalizeMpFieldLinks,
  resolveCardTextForPush,
  resolveDimensionsMmForPush,
  resolveProductDimensionsMmForPush,
  shouldPushDimensions,
} from '../utils/productMpFieldLinks.js';
import {
  getProductImageUrlsForMarketplace,
  getProductImageUrlsForMarketplacePush,
} from './marketplaceProductImages.service.js';
import { WB_ITEM_DIM_CHARC, WB_PACK_DIM_CHARC } from '../utils/marketplaceDimensions.js';
import {
  detectOzonDimensionsLockedFromInfo,
  errorIndicatesOzonVwcLock,
  errorsIndicateOzonVwcLock,
  isOzonPackagingDimensionsLocked,
  withOzonDraftDimensionsLock,
} from '../utils/ozonDimensionsLock.js';
import { isOzonRichContentAttrId } from '../utils/marketplaceRichContent.js';

const ALL_MP = ['ozon', 'wb', 'ym'];

function normalizeMp(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'all') return [...ALL_MP];
  if (m === 'wildberries') return ['wb'];
  if (m === 'yandex' || m === 'yandexmarket') return ['ym'];
  if (ALL_MP.includes(m)) return [m];
  const err = new Error('Неизвестный маркетплейс. Допустимо: ozon, wb, ym, all.');
  err.statusCode = 400;
  throw err;
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parseJsonObject(v) {
  if (v == null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return { ...v };
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

async function loadCategoryPushContext(userCategoryId) {
  if (userCategoryId == null || userCategoryId === '') {
    return { mappings: {}, mpFieldLinks: {} };
  }
  const r = await query(
    `SELECT marketplace_mappings, mp_field_links FROM user_categories WHERE id = $1`,
    [userCategoryId]
  );
  const row = r.rows[0] || {};
  return {
    mappings: parseUserCategoryMarketplaceMappings(row.marketplace_mappings),
    mpFieldLinks: row.mp_field_links,
  };
}

function assertLinked(product, mp) {
  if (mp === 'ozon') {
    const offer = trimOrNull(product.sku_ozon);
    const pid = product.ozon_product_id ?? product.marketplace_ozon_product_id;
    if (!offer && (pid == null || pid === '')) {
      const err = new Error('Товар не связан с Ozon: укажите offer_id или product_id.');
      err.statusCode = 400;
      throw err;
    }
  }
  if (mp === 'wb') {
    if (!trimOrNull(product.sku_wb)) {
      const err = new Error('Товар не связан с Wildberries: укажите nmId.');
      err.statusCode = 400;
      throw err;
    }
  }
  if (mp === 'ym') {
    if (!trimOrNull(product.sku_ym)) {
      const err = new Error('Товар не связан с Яндекс.Маркет: укажите offerId.');
      err.statusCode = 400;
      throw err;
    }
  }
}

function ozonRichContentValue(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return '';
    try {
      const p = JSON.parse(s);
      if (p && typeof p === 'object' && !Array.isArray(p) && (p.content || p.version != null)) {
        return JSON.stringify(p);
      }
    } catch {
      /* already a JSON string or free text */
    }
    return s;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.value != null && typeof raw.value === 'string') return ozonRichContentValue(raw.value);
    if (Array.isArray(raw.content) || raw.version != null) return JSON.stringify(raw);
  }
  return '';
}

function buildOzonAttributesArray(ozonAttrs) {
  const obj = parseJsonObject(ozonAttrs);
  const out = [];
  for (const [key, raw] of Object.entries(obj)) {
    const id = Number(key);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (raw == null || raw === '') continue;

    if (isOzonRichContentAttrId(id)) {
      const s = ozonRichContentValue(raw);
      if (!s) continue;
      out.push({ complex_id: 0, id, values: [{ value: s }] });
      continue;
    }

    let values = null;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      // Явный формат: { dictionary_value_id } | { value }
      if (raw.dictionary_value_id != null && String(raw.dictionary_value_id).trim() !== '') {
        const did = Number(raw.dictionary_value_id);
        if (!Number.isFinite(did) || did <= 0) continue;
        values = [{ dictionary_value_id: did }];
      } else {
        const s = String(raw.value ?? raw.id ?? '').trim();
        if (!s) continue;
        values = [{ value: s }];
      }
    } else {
      const s = String(raw).trim();
      if (!s) continue;
      // «Текст->dictionary_value_id» (импорт / pull) → словарь Ozon
      const arrow = s.indexOf('->');
      if (arrow > 0) {
        const idPart = s.slice(arrow + 2).trim();
        const did = Number(idPart);
        if (Number.isFinite(did) && did > 0 && /^\d+$/.test(idPart)) {
          values = [{ dictionary_value_id: did }];
        } else {
          const textPart = s.slice(0, arrow).trim();
          if (!textPart) continue;
          values = [{ value: textPart }];
        }
      } else {
        // Legacy-строка: всегда value. Раньше цифры (вес 250) уходили как dictionary_value_id →
        // Ozon отклонял атрибут, а импорт отвечал skipped.
        values = [{ value: s }];
      }
    }
    out.push({ complex_id: 0, id, values });
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Человекочитаемые описания кодов ошибок Ozon (когда API отдаёт только code). */
const OZON_ERROR_CODE_RU = {
  warning_attribute_values_out_of_range:
    'Значение характеристики вне допустимого диапазона. Проверьте числовые атрибуты на вкладке Ozon (габариты, вес, количество и т.п.) — они должны попадать в min/max категории.',
  attribute_values_out_of_range:
    'Значение характеристики вне допустимого диапазона. Исправьте число на вкладке Ozon в пределах, которые задаёт категория.',
  ATTR_VALUE_OUT_OF_RANGE:
    'Значение характеристики вне допустимого диапазона.',
  warning_attribute_values_not_from_dictionary:
    'Значение характеристики не из списка Ozon. Выберите вариант из выпадающего списка атрибута, а не вводите вручную.',
  attribute_values_not_from_dictionary:
    'Значение характеристики не из списка Ozon. Выберите значение из справочника.',
  required_attribute_missing:
    'Не заполнен обязательный атрибут. Заполните его на вкладке Ozon.',
  ATTRIBUTE_IS_REQUIRED:
    'Не заполнен обязательный атрибут.',
  price_is_negative:
    'Цена не может быть отрицательной. Проверьте цену товара в кабинете Ozon / выгрузку цен.',
  PRICE_IS_NEGATIVE:
    'Цена не может быть отрицательной.',
  min_price_greater_than_price:
    'Минимальная цена должна быть меньше цены продажи. Исправьте min_price или цену в кабинете Ozon.',
  MIN_PRICE_GREATER_THAN_PRICE:
    'Минимальная цена должна быть меньше цены продажи.',
  warning_description_length:
    'Слишком короткое или длинное описание. Проверьте текст описания на вкладке Ozon.',
  warning_name_length:
    'Слишком короткое или длинное название. Проверьте название на вкладке Ozon.',
  SKU_VWC_IS_NOT_EDITABLE:
    'Изменить габариты и вес нельзя: Ozon уже замерил их и закрепил за карточкой. Если замер неверный — напишите в поддержку Ozon.',
};

function translateOzonErrorCode(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  if (OZON_ERROR_CODE_RU[c]) return OZON_ERROR_CODE_RU[c];
  const lower = c.toLowerCase();
  if (OZON_ERROR_CODE_RU[lower]) return OZON_ERROR_CODE_RU[lower];
  if (/out_of_range/i.test(c)) {
    return 'Значение характеристики вне допустимого диапазона (слишком большое или слишком маленькое).';
  }
  if (/dictionary|not_from_list|enum/i.test(c)) {
    return 'Значение характеристики должно быть из списка Ozon, а не произвольный текст.';
  }
  if (/required/i.test(c)) {
    return 'Не заполнен обязательный атрибут.';
  }
  if (/price/i.test(c) && /negativ|min/i.test(c)) {
    return 'Проблема с ценой или минимальной ценой в кабинете Ozon.';
  }
  return null;
}

function extractOzonErrorTexts(err) {
  if (!err || typeof err !== 'object') return {};
  const texts = err.texts || err.human_texts || err.ErrorHumanTexts || null;
  const fromTexts = texts && typeof texts === 'object'
    ? {
        attribute_name: texts.attribute_name,
        description: texts.description || texts.short_description || texts.message,
        message: texts.message,
        hint_code: texts.hint_code,
        params: texts.params,
      }
    : {};
  return {
    attribute_name: err.attribute_name || fromTexts.attribute_name || err.field || null,
    attribute_id: err.attribute_id ?? err.attributeId ?? null,
    description:
      err.description ||
      fromTexts.description ||
      err.message ||
      fromTexts.message ||
      null,
    code: err.code || fromTexts.hint_code || null,
    level: err.level || null,
    params: Array.isArray(err.params)
      ? err.params
      : Array.isArray(fromTexts.params)
        ? fromTexts.params
        : null,
  };
}

/** Текст одной ошибки import/info / product info для показа пользователю. */
function formatOzonImportErrorLine(err) {
  if (err == null) return null;
  if (typeof err === 'string') {
    const t = err.trim();
    if (!t) return null;
    const translated = translateOzonErrorCode(t);
    return translated && translated !== t ? `${translated} (код: ${t})` : t;
  }

  const parsed = extractOzonErrorTexts(err);
  const attrParts = [];
  if (parsed.attribute_name) attrParts.push(String(parsed.attribute_name).trim());
  if (parsed.attribute_id != null && String(parsed.attribute_id).trim() !== '') {
    attrParts.push(`id ${parsed.attribute_id}`);
  }
  const attrLabel = attrParts.filter(Boolean).join(', ');

  let desc = String(parsed.description || '').trim();
  const code = String(parsed.code || '').trim();
  // Если description — это тот же технический code, переводим
  if (!desc || desc === code || /^[a-z0-9_]+$/i.test(desc)) {
    const translated = translateOzonErrorCode(desc || code);
    if (translated) desc = translated;
  } else if (code && translateOzonErrorCode(code) && desc === code) {
    desc = translateOzonErrorCode(code);
  }

  if (Array.isArray(parsed.params) && parsed.params.length) {
    const paramStr = parsed.params
      .map((p) => {
        if (p == null) return null;
        if (typeof p === 'string') return p;
        const n = String(p.name || p.key || '').trim();
        const v = String(p.value ?? p.val ?? '').trim();
        if (n && v) return `${n}=${v}`;
        return v || n || null;
      })
      .filter(Boolean)
      .join(', ');
    if (paramStr) desc = desc ? `${desc} (${paramStr})` : paramStr;
  }

  if (!attrLabel && !desc && !code) return null;
  if (attrLabel && desc) {
    const withCode =
      code && !desc.includes(code) && !/^[а-яё]/i.test(code) ? ` [${code}]` : '';
    return `${attrLabel}: ${desc}${withCode}`;
  }
  if (desc) {
    if (code && desc !== code && !desc.includes(code) && translateOzonErrorCode(code)) {
      return `${desc} [${code}]`;
    }
    return desc;
  }
  const translated = translateOzonErrorCode(code);
  return translated ? `${translated} (код: ${code})` : code;
}

function splitOzonImportErrors(errors) {
  const critical = [];
  const warnings = [];
  if (!Array.isArray(errors)) return { critical, warnings };
  for (const e of errors) {
    const line = formatOzonImportErrorLine(e);
    if (!line) continue;
    const level = String(e?.level || '').toUpperCase();
    if (level.includes('WARNING')) warnings.push(line);
    else critical.push(line);
  }
  return { critical, warnings };
}

/** Ошибки карточки из /v3/product/info/list (то, что видит кабинет продавца). */
function collectOzonProductInfoErrors(infoItem) {
  if (!infoItem || typeof infoItem !== 'object') return [];
  const raw = [];
  if (Array.isArray(infoItem.errors)) raw.push(...infoItem.errors);
  if (Array.isArray(infoItem.statuses)) {
    for (const st of infoItem.statuses) {
      if (Array.isArray(st?.errors)) raw.push(...st.errors);
      const msg = String(
        st?.message || st?.description || st?.status_description || st?.status_tooltip || ''
      ).trim();
      const name = String(st?.status_name || st?.status || st?.name || '').trim();
      const state = String(st?.status_state || st?.state || '').toUpperCase();
      const failed = st?.is_failed === true || st?.failed === true;
      if (
        msg &&
        (failed ||
          state.includes('FAIL') ||
          state.includes('ERROR') ||
          /ошиб|error|fail/i.test(name) ||
          /ошиб|error|отрицательн|минимальн/i.test(msg))
      ) {
        raw.push({
          level: /недоч|warning|контент/i.test(msg) ? 'ERROR_LEVEL_WARNING' : 'ERROR_LEVEL_ERROR',
          message: msg,
          attribute_name: name || null,
        });
      } else if (msg && (state.includes('WARN') || /недоч|warning/i.test(name))) {
        raw.push({ level: 'ERROR_LEVEL_WARNING', message: msg, attribute_name: name || null });
      }
    }
  }
  const statusObj = infoItem.status;
  if (statusObj && typeof statusObj === 'object') {
    const state = String(statusObj.state || statusObj.status || '').toLowerCase();
    const desc = String(statusObj.state_failed || statusObj.moderate_status || '').trim();
    if (desc && (state.includes('fail') || state.includes('error') || /ошиб/i.test(desc))) {
      raw.push({ level: 'ERROR_LEVEL_ERROR', message: desc });
    }
  }
  const vis = infoItem.visibility_details;
  if (vis && typeof vis === 'object') {
    if (vis.has_price === false) {
      raw.push({
        level: 'ERROR_LEVEL_ERROR',
        message: 'У товара не задана цена (visibility: has_price=false)',
      });
    }
  }
  return raw;
}

async function fetchOzonProductInfoItem(offerId, productId, apiOpts) {
  const body =
    productId != null && Number.isFinite(Number(productId)) && Number(productId) > 0
      ? { product_id: [Number(productId)] }
      : { offer_id: [String(offerId)] };
  const data = await integrationsService._ozonApiPost('/v3/product/info/list', body, apiOpts);
  const items = data?.result?.items ?? data?.items ?? [];
  if (!Array.isArray(items) || items.length === 0) return null;
  const wantOffer = offerId != null ? String(offerId).trim() : '';
  const wantPid = productId != null ? String(productId) : '';
  return (
    items.find(
      (it) =>
        (wantOffer && String(it?.offer_id || '').trim() === wantOffer) ||
        (wantPid && String(it?.id ?? it?.product_id ?? '') === wantPid)
    ) || items[0]
  );
}

function extractOzonPriceFields(infoItem) {
  if (!infoItem || typeof infoItem !== 'object') return {};
  const toPos = (v) => {
    const n = Number(String(v ?? '').replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const price = toPos(infoItem.price ?? infoItem.marketing_price);
  const oldPrice = toPos(infoItem.old_price);
  const minPrice = toPos(infoItem.min_price ?? infoItem.min_price_for_auto_actions_enabled);
  const out = {};
  if (price != null) out.price = String(Math.round(price * 100) / 100);
  if (oldPrice != null && price != null && oldPrice > price) {
    out.old_price = String(Math.round(oldPrice * 100) / 100);
  }
  // min_price должен быть строго меньше price — иначе Ozon: «Измените минимальную цену»
  if (minPrice != null && price != null && minPrice > 0 && minPrice < price) {
    out.min_price = String(Math.round(minPrice * 100) / 100);
  }
  return out;
}

/**
 * Склеиваем результат import с ошибками карточки из product/info/list.
 * Кабинет показывает их даже когда import/info вернул skipped без errors[].
 */
function mergeOzonCardErrorsIntoResult(result, cardErrors, { taskId } = {}) {
  if (!Array.isArray(cardErrors) || cardErrors.length === 0) return result;
  const { critical, warnings } = splitOzonImportErrors(cardErrors);
  if (!critical.length && !warnings.length) return result;

  const parts = [];
  if (critical.length) parts.push(`Критичные ошибки Ozon (карточка):\n${critical.join('\n')}`);
  if (warnings.length) parts.push(`Некритичные замечания Ozon (карточка):\n${warnings.join('\n')}`);
  const cardText = parts.join('\n\n');

  if (critical.length) {
    const prev = result?.error || result?.message || result?.warnings || '';
    return {
      marketplace: 'ozon',
      ok: false,
      taskId: result?.taskId ?? taskId ?? null,
      status: result?.status || 'failed',
      error: prev ? `${prev}\n\n${cardText}` : cardText,
      errors: cardErrors,
      cardErrors,
    };
  }

  // только warnings
  const prev = result?.message || result?.warnings || '';
  return {
    ...(result || { marketplace: 'ozon', ok: true }),
    ok: true,
    warnings: prev ? `${prev}\n\n${cardText}` : cardText,
    message: prev ? `${prev}\n\n${cardText}` : cardText,
    cardErrors,
  };
}

/**
 * Ждём результат /v1/product/import/info после /v3/product/import.
 * Без опроса кабинет показывает ошибки, а ERP — «успех».
 */
async function pollOzonProductImportInfo(taskId, apiOpts, { offerId, maxAttempts = 20, pollIntervalMs = 1500 } = {}) {
  let lastItem = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(pollIntervalMs);
    const data = await integrationsService._ozonApiPost(
      '/v1/product/import/info',
      { task_id: Number(taskId) || taskId },
      apiOpts
    );
    const items = data?.result?.items ?? data?.items ?? [];
    if (!Array.isArray(items) || items.length === 0) continue;
    const want = offerId != null ? String(offerId).trim() : '';
    const item =
      (want ? items.find((it) => String(it?.offer_id || '').trim() === want) : null) || items[0] || null;
    if (!item) continue;
    lastItem = item;
    const status = String(item.status || '').toLowerCase();
    if (status && status !== 'pending') return item;
  }
  return lastItem;
}

function buildOzonImportResult({ offerId, taskId, item }) {
  const status = String(item?.status || 'pending').toLowerCase();
  const { critical, warnings } = splitOzonImportErrors(item?.errors);
  const warnText = warnings.length ? warnings.join('\n') : '';
  const critText = critical.length ? critical.join('\n') : '';

  if (status === 'failed') {
    const parts = [];
    if (critText) parts.push(`Критичные ошибки Ozon:\n${critText}`);
    if (warnText) parts.push(`Некритичные замечания Ozon:\n${warnText}`);
    if (parts.length === 0) {
      parts.push('Ozon отклонил обновление карточки (status: failed). Проверьте кабинет продавца.');
    }
    return {
      marketplace: 'ozon',
      ok: false,
      taskId,
      status,
      error: parts.join('\n\n'),
      errors: item?.errors || [],
    };
  }

  if (status === 'pending' || !item) {
    return {
      marketplace: 'ozon',
      ok: false,
      taskId,
      status: 'pending',
      error:
        `Ozon ещё обрабатывает карточку (task_id: ${taskId}). ` +
        'Статус не успел обновиться — откройте кабинет Ozon или отправьте карточку ещё раз через минуту.',
    };
  }

  // imported / skipped
  if (status === 'skipped') {
    const parts = [
      `Ozon не применил изменений (skipped, task_id: ${taskId}).`,
      'Запрос совпал с карточкой в кабинете или часть полей была проигнорирована.',
      'Проверьте название, описание, габариты упаковки и атрибуты на вкладке Ozon — затем отправьте снова.',
    ];
    if (critText) parts.push(`Критичные ошибки:\n${critText}`);
    if (warnText) parts.push(`Некритичные замечания:\n${warnText}`);
    return {
      marketplace: 'ozon',
      ok: true,
      taskId,
      status: 'skipped',
      warnings: parts.join('\n'),
      message: parts.join('\n'),
      errors: item?.errors || [],
    };
  }

  const base = `Ozon: карточка обновлена (task_id: ${taskId})`;

  if (critText) {
    // Бывает imported с ERROR_LEVEL_* в массиве — всё равно показываем как ошибку.
    return {
      marketplace: 'ozon',
      ok: false,
      taskId,
      status,
      error: `${base}\n\nКритичные ошибки Ozon:\n${critText}${warnText ? `\n\nНекритичные замечания:\n${warnText}` : ''}`,
      errors: item?.errors || [],
    };
  }

  if (warnText) {
    return {
      marketplace: 'ozon',
      ok: true,
      taskId,
      status,
      warnings: warnText,
      message: `${base}\n\nНекритичные замечания Ozon (карточка обновлена, но рейтинг контента может снизиться):\n${warnText}`,
    };
  }

  return {
    marketplace: 'ozon',
    ok: true,
    taskId,
    status,
    message: base,
  };
}

/** Charc id габаритов упаковки — в кабинете WB берутся из `dimensions`, не из characteristics. */
const WB_PACK_DIM_IDS = new Set([
  Number(WB_PACK_DIM_CHARC.length),
  Number(WB_PACK_DIM_CHARC.width),
  Number(WB_PACK_DIM_CHARC.height),
].filter((n) => Number.isFinite(n) && n > 0));

/** Габариты товара (предмет) в characteristics: связь → ERP product_*; иначе draft.productDimensions. */
function mergeWbItemProductDimsIntoAttrs(wbAttrs, product) {
  const dims = resolveProductDimensionsMmForPush(product, 'wb');
  if (!dims) return wbAttrs;
  const next = { ...parseJsonObject(wbAttrs) };
  const setCm = (charcId, mm) => {
    const cm = mmToCm(mm);
    if (cm != null && Number(cm) > 0) next[String(charcId)] = String(cm);
  };
  if (dims.length) setCm(WB_ITEM_DIM_CHARC.length, dims.length);
  if (dims.width) setCm(WB_ITEM_DIM_CHARC.width, dims.width);
  if (dims.height) setCm(WB_ITEM_DIM_CHARC.height, dims.height);
  return next;
}

/**
 * Привести значение из ERP (обычно строка в wb_attributes) к типу, который ждёт Content API.
 * Числовые характеристики нельзя слать строкой — WB отвечает 200, но карточку отклоняет
 * («Числовое значение характеристики … не должно быть строкой»).
 */
function coerceWbCharcValue(raw, existingValue) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((x) => (x == null ? '' : String(x).trim()))
      .filter((s) => s !== '');
  }

  const s = String(raw).trim();
  if (s === '') return null;

  if (typeof existingValue === 'number') {
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (Array.isArray(existingValue)) {
    if (s.includes(';')) {
      return s.split(';').map((x) => x.trim()).filter(Boolean);
    }
    return [s];
  }
  if (typeof existingValue === 'boolean') {
    return s === '1' || s.toLowerCase() === 'true';
  }
  if (typeof existingValue === 'string') {
    return s;
  }

  // Нет образца с карточки: число → number, иначе массив строк (как в примерах WB).
  if (/^-?\d+(?:[.,]\d+)?$/.test(s)) {
    const n = Number(s.replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  if (s.includes(';')) {
    return s.split(';').map((x) => x.trim()).filter(Boolean);
  }
  return [s];
}

/**
 * Собрать characteristics для /cards/update.
 * Полная перезапись карточки: берём текущие с WB (сохраняя типы value), поверх — ERP wb_attributes.
 * Габариты упаковки (pack dim charcs) не передаём — только объект dimensions.
 */
function buildWbCharacteristics(wbAttrs, existingChars = null) {
  const obj = parseJsonObject(wbAttrs);
  const existingList = Array.isArray(existingChars) ? existingChars : [];
  const existingById = new Map();
  for (const c of existingList) {
    const id = Number(c?.id ?? c?.charcID ?? c?.charcId);
    if (Number.isFinite(id) && id > 0) existingById.set(id, c?.value);
  }

  const result = [];
  const seen = new Set();

  for (const c of existingList) {
    const id = Number(c?.id ?? c?.charcID ?? c?.charcId);
    if (!Number.isFinite(id) || id <= 0 || WB_PACK_DIM_IDS.has(id)) continue;
    seen.add(id);
    const erpRaw = obj[String(id)];
    if (erpRaw != null && String(erpRaw).trim() !== '') {
      const value = coerceWbCharcValue(erpRaw, c?.value);
      if (value != null && !(Array.isArray(value) && value.length === 0)) {
        result.push({ id, value });
        continue;
      }
    }
    if (c?.value != null && c.value !== '' && !(Array.isArray(c.value) && c.value.length === 0)) {
      result.push({ id, value: c.value });
    }
  }

  for (const [idStr, raw] of Object.entries(obj)) {
    const id = Number(idStr);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id) || WB_PACK_DIM_IDS.has(id)) continue;
    if (raw == null || String(raw).trim() === '') continue;
    const value = coerceWbCharcValue(raw, existingById.get(id));
    if (value == null || (Array.isArray(value) && value.length === 0)) continue;
    result.push({ id, value });
    seen.add(id);
  }

  return result;
}

/**
 * @param {object} product
 * @param {object} categoryMm
 * @param {{ profileId?: number|string|null, organizationId?: number|string|null }} ctx
 */
async function pushOzonCard(product, categoryMm, ctx) {
  const offerId = trimOrNull(product.sku_ozon) || trimOrNull(product.sku);
  if (!offerId) {
    return { marketplace: 'ozon', ok: false, error: 'Нет offer_id для Ozon' };
  }
  const { descId, typeId } = extractOzonDescTypeForCache(categoryMm || {});
  if (descId <= 0 || typeId <= 0) {
    return {
      marketplace: 'ozon',
      ok: false,
      error: 'В ERP-категории товара не задано сопоставление Ozon (description_category_id и type_id)'
    };
  }

  const name =
    resolveCardTextForPush(product, 'ozon', 'name') || offerId;
  const description = resolveCardTextForPush(product, 'ozon', 'description') || '';

  const item = {
    offer_id: offerId,
    name,
    description_category_id: descId,
    type_id: typeId,
    attributes: buildOzonAttributesArray(product.ozon_attributes)
  };
  if (description) item.description = description;
  const pid = product.ozon_product_id ?? product.marketplace_ozon_product_id;
  if (pid != null && Number.isFinite(Number(pid))) {
    item.product_id = Number(pid);
  }
  if (shouldPushDimensions(product, 'ozon') && !isOzonPackagingDimensionsLocked(product)) {
    const dims = resolveDimensionsMmForPush(product, 'ozon') || {};
    if (dims.weight != null && Number(dims.weight) > 0) {
      item.weight = Number(dims.weight);
      item.weight_unit = 'g';
    }
    if (dims.length && dims.width && dims.height) {
      item.dimension_unit = 'mm';
      item.depth = Number(dims.length);
      item.width = Number(dims.width);
      item.height = Number(dims.height);
    }
  } else if (!isOzonPackagingDimensionsLocked(product)) {
    // Вес без полного комплекта габаритов — всё равно отправляем
    const dims = resolveDimensionsMmForPush(product, 'ozon') || {};
    if (dims.weight != null && Number(dims.weight) > 0) {
      item.weight = Number(dims.weight);
      item.weight_unit = 'g';
    }
  }

  const ozonOverride = await integrationsService.getMarketplaceConfig('ozon', {
    profileId: ctx.profileId ?? null,
    organizationId: ctx.organizationId ?? null
  });
  if (!integrationsService._hasOzonCredentials(ozonOverride)) {
    return { marketplace: 'ozon', ok: false, error: 'Кабинет Ozon не настроен для организации' };
  }

  const apiOpts = {
    profileId: ctx.profileId ?? null,
    ozonOverride,
  };

  // Цена обязательна в /v3/product/import: без неё кабинет часто пишет
  // «Цена не может быть отрицательной» / проблемы с min_price, а import/info — skipped.
  let ozonInfoBefore = null;
  try {
    ozonInfoBefore = await fetchOzonProductInfoItem(offerId, item.product_id ?? null, apiOpts);
    const priceFields = extractOzonPriceFields(ozonInfoBefore);
    Object.assign(item, priceFields);
    if (ozonInfoBefore?.id != null && item.product_id == null) {
      const idNum = Number(ozonInfoBefore.id);
      if (Number.isFinite(idNum) && idNum > 0) item.product_id = idNum;
    }
    if (detectOzonDimensionsLockedFromInfo(ozonInfoBefore)) {
      delete item.depth;
      delete item.width;
      delete item.height;
      delete item.dimension_unit;
      delete item.weight;
      delete item.weight_unit;
      if (!isOzonPackagingDimensionsLocked(product)) {
        try {
          const nextDraft = withOzonDraftDimensionsLock(product.ozon_draft, true);
          await productsService.update(product.id, { ozon_draft: nextDraft }, {
            profileId: ctx.profileId ?? null,
          });
          product = { ...product, ozon_draft: nextDraft };
        } catch (e) {
          logger.warn('[CardPush] Failed to persist Ozon dimensionsLocked flag', e?.message || e);
        }
      }
    }
  } catch (e) {
    logger.warn('[CardPush] Ozon product/info/list (pre-import) failed', {
      offerId,
      error: e?.message || String(e),
    });
  }

  // JPEG URL заранее: и в /v3/product/import, и в pictures/import
  let picUrls = [];
  try {
    picUrls = (await getProductImageUrlsForMarketplacePush(product, 'ozon')).slice(0, 15);
  } catch (e) {
    logger.warn('[CardPush] Ozon image URL resolve failed', {
      offerId,
      error: e?.message || String(e),
    });
  }
  if (picUrls.length > 0) {
    item.images = picUrls;
    item.primary_image = picUrls[0];
  }
  logger.warn('[CardPush] Ozon pictures prepared', {
    offerId,
    product_id: item.product_id ?? null,
    count: picUrls.length,
    preview: picUrls.slice(0, 3),
    publicBase: String(process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '').trim() || null,
  });

  try {
    logger.info('[CardPush] Ozon import payload', {
      offerId,
      product_id: item.product_id ?? null,
      attrs: Array.isArray(item.attributes) ? item.attributes.length : 0,
      hasDims: item.depth != null,
      weight: item.weight ?? null,
      price: item.price ?? null,
      min_price: item.min_price ?? null,
      images: picUrls.length,
      nameLen: String(item.name || '').length,
    });

    const data = await integrationsService._ozonApiPost(
      '/v3/product/import',
      { items: [item] },
      apiOpts
    );
    const taskId = data?.result?.task_id ?? data?.task_id ?? null;
    if (taskId == null || taskId === '') {
      return {
        marketplace: 'ozon',
        ok: false,
        error: 'Ozon принял запрос, но не вернул task_id — результат обновления неизвестен',
      };
    }

    let itemResult;
    try {
      itemResult = await pollOzonProductImportInfo(taskId, apiOpts, { offerId });
    } catch (pollErr) {
      logger.warn('[CardPush] Ozon import/info poll failed', {
        taskId,
        offerId,
        error: pollErr?.message || String(pollErr),
      });
      return {
        marketplace: 'ozon',
        ok: false,
        taskId,
        error:
          `Задача Ozon создана (task_id: ${taskId}), но не удалось получить статус: ${
            pollErr?.message || String(pollErr)
          }. Проверьте ошибки в кабинете продавца.`,
      };
    }

    let result = buildOzonImportResult({ offerId, taskId, item: itemResult });

    // skipped + есть атрибуты: добиваем через /v1/product/attributes/update
    const status = String(itemResult?.status || result.status || '').toLowerCase();
    const pid = item.product_id;
    if (
      status === 'skipped' &&
      pid != null &&
      Array.isArray(item.attributes) &&
      item.attributes.length > 0
    ) {
      try {
        const upd = await integrationsService._ozonApiPost(
          '/v1/product/attributes/update',
          {
            items: [
              {
                offer_id: offerId,
                product_id: Number(pid),
                attributes: item.attributes,
              },
            ],
          },
          apiOpts
        );
        const updTaskId = upd?.result?.task_id ?? upd?.task_id ?? null;
        if (updTaskId != null && updTaskId !== '') {
          const updItem = await pollOzonProductImportInfo(updTaskId, apiOpts, { offerId });
          result = buildOzonImportResult({ offerId, taskId: updTaskId, item: updItem });
          if (result.status === 'skipped') {
            result = {
              ...result,
              message:
                `${result.message}\n\nДополнительно отправлены характеристики (attributes/update) — Ozon снова ответил skipped.`,
              warnings: result.warnings || result.message,
            };
          } else if (result.ok) {
            result = {
              ...result,
              message: `Ozon: характеристики обновлены через attributes/update (task_id: ${updTaskId})`,
            };
          }
        } else {
          result = {
            ...result,
            message:
              `${result.message}\n\nДополнительно отправлен запрос attributes/update (без task_id). Проверьте карточку в кабинете.`,
            warnings: result.warnings || result.message,
          };
        }
      } catch (attrErr) {
        logger.warn('[CardPush] Ozon attributes/update failed', {
          offerId,
          error: attrErr?.message || String(attrErr),
        });
        result = {
          marketplace: 'ozon',
          ok: false,
          taskId,
          status: 'skipped',
          error:
            `${result.message || result.warnings || 'Ozon: skipped'}\n\n` +
            `Повторная отправка характеристик не удалась: ${attrErr?.message || String(attrErr)}`,
        };
      }
    }

    // Картинки отдельным методом (на случай skipped у import без применения images)
    let imagesPushed = 0;
    try {
      const productIdForPics = item.product_id ?? ozonInfoBefore?.id ?? null;
      if (productIdForPics != null && Number(productIdForPics) > 0 && picUrls.length > 0) {
        await integrationsService._ozonApiPost(
          '/v1/product/pictures/import',
          { product_id: Number(productIdForPics), images: picUrls },
          apiOpts
        );
        imagesPushed = picUrls.length;
        result = {
          ...result,
          message: `${result.message || 'Ozon: карточка отправлена'}\nИзображения: ${imagesPushed} шт.`,
          imagesPushed,
        };
      } else if (picUrls.length === 0) {
        result = {
          ...result,
          warnings:
            `${result.warnings ? `${result.warnings}\n` : ''}` +
            'Изображения не отправлены: нет фото с включённым бейджем Ozon (или URL не публичные JPEG/PNG).',
        };
      } else if (picUrls.length > 0 && (productIdForPics == null || Number(productIdForPics) <= 0)) {
        result = {
          ...result,
          warnings:
            `${result.warnings ? `${result.warnings}\n` : ''}` +
            'Изображения не отправлены: нет product_id Ozon (сохраните связь и повторите).',
        };
      }
    } catch (e) {
      logger.warn('[CardPush] Ozon pictures/import failed', {
        offerId,
        error: e?.message || String(e),
      });
      result = {
        ...result,
        warnings:
          `${result.warnings ? `${result.warnings}\n` : ''}` +
          `Изображения Ozon: ${e?.message || String(e)}`,
      };
    }

    // Ошибки карточки — ПОСЛЕ отправки фото (иначе висим на старом error_card_with_deleted_photos)
    try {
      await sleep(imagesPushed > 0 ? 3500 : 1500);
      const ozonInfoAfter = await fetchOzonProductInfoItem(
        offerId,
        item.product_id ?? ozonInfoBefore?.id ?? null,
        apiOpts
      );
      let cardErrors = collectOzonProductInfoErrors(ozonInfoAfter);
      // Если только что отправили фото — «удалили все фото» ещё может висеть, пока Ozon качает URL
      if (imagesPushed > 0) {
        cardErrors = cardErrors.filter((e) => {
          const code = String(e?.code || e?.message || e?.description || '').toLowerCase();
          return !code.includes('error_card_with_deleted_photos') && !/удалили все фото/i.test(code);
        });
      }
      result = mergeOzonCardErrorsIntoResult(result, cardErrors, { taskId: result.taskId || taskId });
      if (cardErrors.length) {
        logger.warn('[CardPush] Ozon card errors after import', {
          offerId,
          count: cardErrors.length,
          preview: cardErrors
            .slice(0, 5)
            .map((e) => formatOzonImportErrorLine(e))
            .filter(Boolean),
        });
      }
      const vwcLocked =
        detectOzonDimensionsLockedFromInfo(ozonInfoAfter) ||
        errorsIndicateOzonVwcLock(cardErrors) ||
        errorIndicatesOzonVwcLock(result?.error) ||
        errorIndicatesOzonVwcLock(result?.warnings);
      if (vwcLocked) {
        try {
          const nextDraft = withOzonDraftDimensionsLock(product.ozon_draft, true);
          await productsService.update(product.id, { ozon_draft: nextDraft }, {
            profileId: ctx.profileId ?? null,
          });
        } catch (e) {
          logger.warn('[CardPush] Failed to persist Ozon dimensionsLocked after import', e?.message || e);
        }
      }
    } catch (e) {
      logger.warn('[CardPush] Ozon product/info/list (post-import) failed', {
        offerId,
        error: e?.message || String(e),
      });
    }

    if (!result.ok) {
      logger.warn('[CardPush] Ozon import finished with errors', {
        taskId,
        offerId,
        status: result.status,
        errorPreview: String(result.error || '').slice(0, 500),
      });
    }
    return result;
  } catch (e) {
    return { marketplace: 'ozon', ok: false, error: e?.message || String(e) };
  }
}

async function pushWildberriesCard(product, categoryMm, ctx) {
  const nmId = Number(product.sku_wb);
  if (!Number.isFinite(nmId) || nmId < 1) {
    return { marketplace: 'wb', ok: false, error: 'Некорректный nmId WB' };
  }
  // subjectId нужен для создания карточки; /cards/update категорию не меняет (ограничение WB API).
  const subjectId = Number(categoryMm?.wb ?? categoryMm?.wb_subject_id ?? 0);
  const hasSubjectMapping = Number.isFinite(subjectId) && subjectId >= 1;

  let existing = null;
  try {
    existing = await integrationsService.getWildberriesProductInfo({
      nm_id: nmId,
      profileId: ctx.profileId,
      organizationId: ctx.organizationId
    });
  } catch (e) {
    logger.warn('[MP Card Push] WB fetch card before update:', e?.message);
  }

  if (!existing && !hasSubjectMapping) {
    return {
      marketplace: 'wb',
      ok: false,
      error: 'В ERP-категории не задано сопоставление WB (subjectId), карточка на WB не найдена'
    };
  }

  const title =
    resolveCardTextForPush(product, 'wb', 'name') ||
    (existing?.title ? String(existing.title) : null);
  const description =
    resolveCardTextForPush(product, 'wb', 'description') ||
    (existing?.description != null ? String(existing.description) : '');
  const brand =
    resolveCardTextForPush(product, 'wb', 'brand') ||
    trimOrNull(existing?.brand);
  const vendorCode =
    resolveCardTextForPush(product, 'wb', 'sku') ||
    trimOrNull(existing?.vendorCode) ||
    trimOrNull(product.sku);

  // update полностью перезаписывает карточку — сохраняем поля с МП, если в ERP пусто
  const card = {
    nmID: nmId,
    vendorCode: vendorCode || String(nmId),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(brand ? { brand } : {})
  };

  const wbAttrsForChars = mergeWbItemProductDimsIntoAttrs(product.wb_attributes, product);
  const chars = buildWbCharacteristics(wbAttrsForChars, existing?.characteristics);
  if (chars.length > 0) {
    card.characteristics = chars;
  }

  if (existing?.sizes && Array.isArray(existing.sizes) && existing.sizes.length > 0) {
    // Не трогаем barcodes/цены размеров — только сохраняем структуру для полной перезаписи.
    card.sizes = existing.sizes.map((s) => ({
      ...(s?.chrtID != null ? { chrtID: s.chrtID } : {}),
      techSize: s?.techSize ?? s?.tech_size ?? '0',
      wbSize: s?.wbSize ?? s?.wb_size ?? '',
      skus: Array.isArray(s?.skus) ? s.skus : [],
    }));
  }

  // ERP: мм / г; WB Content API: габариты упаковки только в dimensions (см + weightBrutto кг).
  // Pack-charcs 90849/90745/90846 больше не шлём: кабинет читает dimensions, а строковые
  // числовые характеристики ломают весь /cards/update (200 + ошибка в error/list).
  if (shouldPushDimensions(product, 'wb')) {
    const dims = resolveDimensionsMmForPush(product, 'wb') || {};
    const L = Number(dims.length);
    const W = Number(dims.width);
    const H = Number(dims.height);
    if (Number.isFinite(L) && L > 0 && Number.isFinite(W) && W > 0 && Number.isFinite(H) && H > 0) {
      const lengthCm = mmToCm(L);
      const widthCm = mmToCm(W);
      const heightCm = mmToCm(H);
      const weightKg = dims.weight != null && Number(dims.weight) > 0 ? gramsToKg(dims.weight) : null;
      card.dimensions = {
        length: lengthCm,
        width: widthCm,
        height: heightCm,
        ...(weightKg != null
          ? { weightBrutto: weightKg }
          : existing?.dimensions?.weightBrutto != null
            ? { weightBrutto: Number(existing.dimensions.weightBrutto) }
            : {})
      };
    } else if (existing?.dimensions && typeof existing.dimensions === 'object') {
      card.dimensions = existing.dimensions;
    }
  } else if (existing?.dimensions && typeof existing.dimensions === 'object') {
    card.dimensions = existing.dimensions;
  }

  try {
    await integrationsService._wbContentApiPost('/content/v2/cards/update', [card], {
      profileId: ctx.profileId,
      organizationId: ctx.organizationId
    });

    // Тихие отказы WB: HTTP 200, но карточка в error/list
    try {
      const errList = await integrationsService._wbContentApiPost(
        '/content/v2/cards/error/list',
        { cursor: { updatedAt: null, nmID: 0, limit: 50 }, order: { ascending: false } },
        { profileId: ctx.profileId, organizationId: ctx.organizationId }
      );
      const items = Array.isArray(errList?.data?.items) ? errList.data.items : [];
      const vendor = String(card.vendorCode || '').trim();
      const nowMs = Date.now();
      const hit = items.find((it) => {
        const updatedMs = it?.updatedAt ? Date.parse(it.updatedAt) : NaN;
        // Только свежие отказы (иначе цепляем старые строки из прошлых выгрузок).
        if (!Number.isFinite(updatedMs) || nowMs - updatedMs > 5 * 60 * 1000) return false;
        const codes = Array.isArray(it?.vendorCodes) ? it.vendorCodes : [];
        if (vendor && codes.some((c) => String(c) === vendor)) return true;
        const errMap = it?.errors && typeof it.errors === 'object' ? it.errors : {};
        return vendor && Object.prototype.hasOwnProperty.call(errMap, vendor);
      });
      if (hit) {
        const msgs = hit.errors?.[vendor];
        const text = Array.isArray(msgs) ? msgs.join('; ') : String(msgs || 'ошибка обновления карточки');
        return { marketplace: 'wb', ok: false, error: `WB отклонил карточку: ${text}` };
      }
    } catch (e) {
      logger.warn('[MP Card Push] WB error/list check failed:', e?.message || e);
    }

    let imagesNote = '';
    const picUrls = getProductImageUrlsForMarketplace(product, 'wb');
    if (picUrls.length > 0) {
      try {
        await integrationsService._wbContentApiPost(
          '/content/v3/media/save',
          { nmId, data: picUrls },
          { profileId: ctx.profileId, organizationId: ctx.organizationId }
        );
        imagesNote = `; изображения: ${picUrls.length} шт.`;
      } catch (imgErr) {
        logger.warn('[CardPush] WB media/save failed', {
          nmId,
          error: imgErr?.message || String(imgErr),
        });
        imagesNote = `; изображения: ошибка (${imgErr?.message || String(imgErr)})`;
      }
    }

    const subjectNote =
      hasSubjectMapping &&
      existing?.subjectID != null &&
      Number(existing.subjectID) !== subjectId
        ? ` (категория WB subjectId ${existing.subjectID} → ${subjectId} через API не меняется — только контент)`
        : '';
    return {
      marketplace: 'wb',
      ok: true,
      message: `Карточка WB (nmId ${nmId}) отправлена на обновление${subjectNote}${imagesNote}`,
      imagesPushed: picUrls.length,
      subjectIdUnchanged:
        hasSubjectMapping &&
        existing?.subjectID != null &&
        Number(existing.subjectID) !== subjectId
    };
  } catch (e) {
    return { marketplace: 'wb', ok: false, error: e?.message || String(e) };
  }
}

async function pushYandexCard(product, categoryMm, ctx) {
  const offerId = trimOrNull(product.sku_ym);
  if (!offerId) {
    return { marketplace: 'ym', ok: false, error: 'Нет offerId для Яндекс.Маркет' };
  }

  const cfg = await integrationsService.getMarketplaceConfig('yandex', {
    profileId: ctx.profileId ?? null,
    organizationId: ctx.organizationId ?? null
  });
  const apiKey = integrationsService._normalizeYandexApiKey(cfg?.api_key ?? cfg?.apiKey);
  if (!apiKey) {
    return { marketplace: 'ym', ok: false, error: 'Api-Key Яндекс.Маркета не настроен' };
  }

  let businessId = cfg?.business_id ?? cfg?.businessId ?? null;
  const campaignId = cfg?.campaign_id ?? cfg?.campaignId ?? null;
  if ((businessId == null || businessId === '') && campaignId) {
    try {
      const meta = await integrationsService._fetchYandexCampaignSnapshot(campaignId, apiKey);
      businessId = meta?.businessId ?? businessId;
    } catch (_) {
      /* ignore */
    }
  }
  const bid = businessId != null ? Number(businessId) : NaN;
  if (!Number.isFinite(bid) || bid < 1) {
    return { marketplace: 'ym', ok: false, error: 'Укажите business_id в кабинете Яндекс.Маркета' };
  }

  const name = resolveCardTextForPush(product, 'ym', 'name');
  const description = resolveCardTextForPush(product, 'ym', 'description');

  const offer = { offerId };
  if (name) offer.name = name;
  if (description) offer.description = description;

  const ymAttrs = parseJsonObject(product.ym_attributes);
  const parameterValues = Object.entries(ymAttrs)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([paramId, v]) => ({
      parameterId: Number(paramId),
      value: String(v).trim()
    }))
    .filter((p) => Number.isFinite(p.parameterId) && p.parameterId > 0);
  if (parameterValues.length > 0) {
    offer.parameterValues = parameterValues;
  }

  const ymCategoryId = trimOrNull(categoryMm?.ym ?? categoryMm?.yandex);
  if (ymCategoryId && /^\d+$/.test(ymCategoryId)) {
    offer.marketCategoryId = Number(ymCategoryId);
  }

  // YM Partner API: length/width/height — см, weight — кг
  // Связь вкл. → из ERP; выкл. → из ym_draft.weightDimensions (если есть)
  {
    const links = normalizeMpFieldLinks(product.mp_field_links);
    let wd = null;
    if (isMpFieldLinked(links, 'dimensions', 'ym')) {
      const L = mmToCm(product.length);
      const W = mmToCm(product.width);
      const H = mmToCm(product.height);
      const Wt = gramsToKg(product.weight);
      if (L != null && W != null && H != null) {
        wd = { length: L, width: W, height: H, ...(Wt != null ? { weight: Wt } : {}) };
      }
    } else {
      const draft =
        product.ym_draft && typeof product.ym_draft === 'object' && !Array.isArray(product.ym_draft)
          ? product.ym_draft
          : typeof product.ym_draft === 'string'
            ? (() => {
                try {
                  return JSON.parse(product.ym_draft);
                } catch {
                  return null;
                }
              })()
            : null;
      const raw = draft?.weightDimensions;
      if (raw && typeof raw === 'object') {
        const L = Number(raw.length);
        const W = Number(raw.width);
        const H = Number(raw.height);
        const Wt = Number(raw.weight);
        if (Number.isFinite(L) && L > 0 && Number.isFinite(W) && W > 0 && Number.isFinite(H) && H > 0) {
          wd = {
            length: L,
            width: W,
            height: H,
            ...(Number.isFinite(Wt) && Wt > 0 ? { weight: Wt } : {}),
          };
        }
      }
    }
    if (wd) offer.weightDimensions = wd;
  }

  if (isMpFieldLinked(product.mp_field_links, 'country', 'ym')) {
    const country = String(product.country_of_origin || '').trim();
    if (country) {
      offer.manufacturerCountries = [country];
    }
  } else {
    let draft =
      product.ym_draft && typeof product.ym_draft === 'object' && !Array.isArray(product.ym_draft)
        ? product.ym_draft
        : null;
    if (!draft && typeof product.ym_draft === 'string') {
      try {
        draft = JSON.parse(product.ym_draft);
      } catch {
        draft = null;
      }
    }
    const list = Array.isArray(draft?.manufacturerCountries) ? draft.manufacturerCountries : [];
    const country = list.map((c) => String(c || '').trim()).find(Boolean) || '';
    if (country) {
      offer.manufacturerCountries = [country];
    }
  }

  const picUrls = getProductImageUrlsForMarketplace(product, 'ym');
  if (picUrls.length > 0) {
    offer.pictures = picUrls;
  }

  const fetch = (await import('node-fetch')).default;
  const agent = getYandexHttpsAgent();
  const url = `https://api.partner.market.yandex.ru/v2/businesses/${encodeURIComponent(String(bid))}/offer-mappings/update`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Api-Key': apiKey
      },
      body: JSON.stringify({ offerMappings: [{ offer }] }),
      ...(agent ? { agent } : {})
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      let msg = `Яндекс.Маркет API ${response.status}`;
      try {
        const j = JSON.parse(text);
        if (j?.errors?.[0]?.message) msg += `: ${j.errors[0].message}`;
        else if (j?.message) msg += `: ${j.message}`;
      } catch (_) {
        if (text) msg += `: ${text.substring(0, 200)}`;
      }
      return { marketplace: 'ym', ok: false, error: msg };
    }
    return {
      marketplace: 'ym',
      ok: true,
      message: `Предложение «${offerId}» отправлено на обновление в Яндекс.Маркет`
    };
  } catch (e) {
    return { marketplace: 'ym', ok: false, error: e?.message || String(e) };
  }
}

async function pushProductToMp(product, mp, opts) {
  assertLinked(product, mp);
  const orgId = product.organization_id ?? product.organizationId ?? opts.organizationId;
  if (orgId == null || orgId === '') {
    const err = new Error('У товара не указана организация.');
    err.statusCode = 400;
    throw err;
  }
  const categoryId = product.user_category_id ?? product.categoryId;
  const { mappings: categoryMm, mpFieldLinks: catLinks } = await loadCategoryPushContext(categoryId);
  const productForPush = {
    ...product,
    mp_field_links: overlayCategoryDedicatedMpLinks(product.mp_field_links, catLinks),
  };
  const ctx = {
    profileId: opts.profileId ?? product.profile_id ?? product.profileId ?? null,
    organizationId: orgId
  };
  if (mp === 'ozon') return pushOzonCard(productForPush, categoryMm, ctx);
  if (mp === 'wb') return pushWildberriesCard(productForPush, categoryMm, ctx);
  if (mp === 'ym') return pushYandexCard(productForPush, categoryMm, ctx);
  return { marketplace: mp, ok: false, error: 'unsupported' };
}

/**
 * @param {number|string} productId
 * @param {'ozon'|'wb'|'ym'|'all'|string} marketplace
 * @param {{ profileId?: number|string|null }} [opts]
 */
export async function pushProductCard(productId, marketplace, opts = {}) {
  const product = await productsService.getById(productId);
  if (!product) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }
  const mps = normalizeMp(marketplace);
  const results = [];
  for (const mp of mps) {
    try {
      results.push(await pushProductToMp(product, mp, opts));
    } catch (e) {
      results.push({
        marketplace: mp,
        ok: false,
        error: e?.message || String(e)
      });
    }
  }
  const ok = results.every((r) => r.ok);
  return { productId: product.id, ok, results };
}

/**
 * @param {{ productIds: Array<number|string>, marketplaces: string|string[] }} payload
 * @param {{ profileId?: number|string|null }} [opts]
 */
export async function pushProductCardsBulk(payload, opts = {}) {
  const ids = Array.isArray(payload?.productIds) ? payload.productIds : [];
  if (ids.length === 0) {
    const err = new Error('Укажите productIds');
    err.statusCode = 400;
    throw err;
  }
  const mpRaw = payload.marketplaces ?? payload.marketplace ?? 'all';
  const mps = Array.isArray(mpRaw) ? mpRaw.flatMap((m) => normalizeMp(m)) : normalizeMp(mpRaw);
  const uniqueMps = [...new Set(mps)];

  const items = [];
  for (const productId of ids) {
    try {
      const product = await productsService.getById(productId);
      if (!product) {
        items.push({
          productId,
          ok: false,
          results: uniqueMps.map((mp) => ({
            marketplace: mp,
            ok: false,
            error: 'Товар не найден'
          }))
        });
        continue;
      }
      const results = [];
      for (const mp of uniqueMps) {
        try {
          results.push(await pushProductToMp(product, mp, opts));
        } catch (e) {
          results.push({ marketplace: mp, ok: false, error: e?.message || String(e) });
        }
      }
      items.push({ productId: product.id, ok: results.every((r) => r.ok), results });
    } catch (e) {
      items.push({
        productId,
        ok: false,
        results: uniqueMps.map((mp) => ({
          marketplace: mp,
          ok: false,
          error: e?.message || String(e)
        }))
      });
    }
  }
  const success = items.filter((i) => i.ok).length;
  return {
    total: items.length,
    success,
    failed: items.length - success,
    items
  };
}

/** Выкл: MARKETPLACE_CARD_AUTO_PUSH_ENABLED=0 */
export function isCardAutoPushEnabled() {
  const v = process.env.MARKETPLACE_CARD_AUTO_PUSH_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

const _cardPushTimers = new Map();
const _categoryPushTimers = new Map();

/**
 * Отложенный пуш карточки товара на МП (debounce).
 * @param {number|string} productId
 * @param {{ marketplaces?: string|string[], reason?: string, delayMs?: number, profileId?: number|string|null }} [opts]
 */
export function schedulePushProductCard(productId, opts = {}) {
  if (!isCardAutoPushEnabled()) return;
  const id = Number(productId);
  if (!Number.isFinite(id) || id < 1) return;
  const mps = opts.marketplaces ?? 'all';
  const key = `${id}|${Array.isArray(mps) ? mps.join(',') : String(mps)}`;
  const prev = _cardPushTimers.get(key);
  if (prev) clearTimeout(prev);
  const delayMs = Math.max(500, Number(opts.delayMs) || 2500);
  const t = setTimeout(() => {
    _cardPushTimers.delete(key);
    pushProductCard(id, mps, { profileId: opts.profileId ?? null })
      .then((out) => {
        logger.info('[MP Card Push] auto push done', {
          productId: id,
          reason: opts.reason || null,
          ok: out?.ok,
          results: (out?.results || []).map((r) => ({
            marketplace: r.marketplace,
            ok: r.ok,
            error: r.error || null,
          })),
        });
      })
      .catch((e) => {
        logger.warn('[MP Card Push] schedulePushProductCard failed', {
          productId: id,
          reason: opts.reason || null,
          message: e?.message || String(e),
        });
      });
  }, delayMs);
  _cardPushTimers.set(key, t);
}

/**
 * После смены сопоставления ERP-категории — отправить карточки всех товаров этой категории.
 * @param {number|string} userCategoryId
 * @param {{ marketplaces?: string|string[], reason?: string, delayMs?: number, profileId?: number|string|null }} [opts]
 */
export function schedulePushCardsForCategory(userCategoryId, opts = {}) {
  if (!isCardAutoPushEnabled()) return;
  const catId = Number(userCategoryId);
  if (!Number.isFinite(catId) || catId < 1) return;
  const prev = _categoryPushTimers.get(catId);
  if (prev) clearTimeout(prev);
  const delayMs = Math.max(800, Number(opts.delayMs) || 3000);
  const t = setTimeout(() => {
    _categoryPushTimers.delete(catId);
    (async () => {
      const r = await query(
        `SELECT id FROM products
         WHERE user_category_id = $1
         ORDER BY id ASC
         LIMIT 500`,
        [catId]
      );
      const ids = (r.rows || [])
        .map((row) => Number(row.id))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (!ids.length) {
        logger.info('[MP Card Push] category mapping changed, no products', { userCategoryId: catId });
        return;
      }
      logger.info('[MP Card Push] category mapping → push products', {
        userCategoryId: catId,
        count: ids.length,
        reason: opts.reason || 'category_mapping_changed',
      });
      for (const productId of ids) {
        schedulePushProductCard(productId, {
          marketplaces: opts.marketplaces ?? 'all',
          reason: opts.reason || 'category_mapping_changed',
          delayMs: 400 + (productId % 7) * 150,
          profileId: opts.profileId ?? null,
        });
      }
    })().catch((e) => {
      logger.warn('[MP Card Push] schedulePushCardsForCategory failed', {
        userCategoryId: catId,
        message: e?.message || String(e),
      });
    });
  }, delayMs);
  _categoryPushTimers.set(catId, t);
}

export default {
  pushProductCard,
  pushProductCardsBulk,
  schedulePushProductCard,
  schedulePushCardsForCategory,
  isCardAutoPushEnabled,
};
