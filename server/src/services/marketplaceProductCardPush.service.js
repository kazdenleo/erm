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
  isMpFieldLinked,
  mmToCm,
  normalizeMpFieldLinks,
  resolveCardTextForPush,
  resolveDimensionsMmForPush,
  shouldPushDimensions,
} from '../utils/productMpFieldLinks.js';

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

async function loadCategoryMappings(userCategoryId) {
  if (userCategoryId == null || userCategoryId === '') return {};
  const r = await query(`SELECT marketplace_mappings FROM user_categories WHERE id = $1`, [
    userCategoryId
  ]);
  return parseUserCategoryMarketplaceMappings(r.rows[0]?.marketplace_mappings);
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

function buildOzonAttributesArray(ozonAttrs) {
  const obj = parseJsonObject(ozonAttrs);
  const out = [];
  for (const [key, raw] of Object.entries(obj)) {
    const id = Number(key);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (raw == null || raw === '') continue;

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
      // Legacy-строка: всегда value. Раньше цифры (вес 250) уходили как dictionary_value_id →
      // Ozon отклонял атрибут, а импорт отвечал skipped.
      values = [{ value: s }];
    }
    out.push({ complex_id: 0, id, values });
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Текст одной ошибки import/info для показа пользователю. */
function formatOzonImportErrorLine(err) {
  if (err == null) return null;
  if (typeof err === 'string') {
    const t = err.trim();
    return t || null;
  }
  const attr = String(err.attribute_name || err.field || '').trim();
  const desc = String(err.description || err.message || err.code || '').trim();
  if (!attr && !desc) return null;
  return attr && desc ? `${attr}: ${desc}` : attr || desc;
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

function buildWbCharacteristics(wbAttrs) {
  const obj = parseJsonObject(wbAttrs);
  return Object.entries(obj)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([id, v]) => ({
      id: Number(id),
      value: String(v).trim()
    }))
    .filter((c) => Number.isFinite(c.id) && c.id > 0);
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
  if (shouldPushDimensions(product, 'ozon')) {
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
  } else {
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

  try {
    logger.info('[CardPush] Ozon import payload', {
      offerId,
      product_id: item.product_id ?? null,
      attrs: Array.isArray(item.attributes) ? item.attributes.length : 0,
      hasDims: item.depth != null,
      weight: item.weight ?? null,
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

  const chars = buildWbCharacteristics(product.wb_attributes);
  if (chars.length > 0) {
    card.characteristics = chars;
  } else if (Array.isArray(existing?.characteristics) && existing.characteristics.length > 0) {
    card.characteristics = existing.characteristics
      .map((c) => ({
        id: Number(c?.id ?? c?.charcID ?? c?.charcId),
        value: Array.isArray(c?.value) ? c.value : c?.value != null ? [String(c.value)] : []
      }))
      .filter((c) => Number.isFinite(c.id) && c.id > 0 && c.value.length > 0);
  }

  if (existing?.sizes && Array.isArray(existing.sizes) && existing.sizes.length > 0) {
    card.sizes = existing.sizes;
  }

  // ERP: мм / г; WB Content API: габариты в см, weightBrutto в граммах.
  if (shouldPushDimensions(product, 'wb')) {
    const dims = resolveDimensionsMmForPush(product, 'wb') || {};
    const L = Number(dims.length);
    const W = Number(dims.width);
    const H = Number(dims.height);
    if (Number.isFinite(L) && L > 0 && Number.isFinite(W) && W > 0 && Number.isFinite(H) && H > 0) {
      card.dimensions = {
        length: mmToCm(L),
        width: mmToCm(W),
        height: mmToCm(H),
        ...(dims.weight != null && Number(dims.weight) > 0
          ? { weightBrutto: Number(dims.weight) }
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
    const subjectNote =
      hasSubjectMapping &&
      existing?.subjectID != null &&
      Number(existing.subjectID) !== subjectId
        ? ` (категория WB subjectId ${existing.subjectID} → ${subjectId} через API не меняется — только контент)`
        : '';
    return {
      marketplace: 'wb',
      ok: true,
      message: `Карточка WB (nmId ${nmId}) отправлена на обновление${subjectNote}`,
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
  const categoryMm = await loadCategoryMappings(categoryId);
  const ctx = {
    profileId: opts.profileId ?? product.profile_id ?? product.profileId ?? null,
    organizationId: orgId
  };
  if (mp === 'ozon') return pushOzonCard(product, categoryMm, ctx);
  if (mp === 'wb') return pushWildberriesCard(product, categoryMm, ctx);
  if (mp === 'ym') return pushYandexCard(product, categoryMm, ctx);
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
