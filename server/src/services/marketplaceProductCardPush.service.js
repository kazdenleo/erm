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
    if (raw == null || String(raw).trim() === '') continue;
    const s = String(raw).trim();
    const num = Number(s);
    const asDict = Number.isFinite(num) && num > 0 && /^\d+$/.test(s);
    out.push({
      complex_id: 0,
      id,
      values: asDict ? [{ dictionary_value_id: num }] : [{ value: s }]
    });
  }
  return out;
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
    trimOrNull(product.mp_ozon_name) || trimOrNull(product.name) || offerId;
  const description =
    trimOrNull(product.mp_ozon_description) || trimOrNull(product.description) || '';

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
  if (product.weight != null && Number(product.weight) > 0) {
    item.weight = Number(product.weight);
  }
  if (product.length && product.width && product.height) {
    item.dimension_unit = 'mm';
    item.depth = Number(product.length);
    item.width = Number(product.width);
    item.height = Number(product.height);
  }

  const ozonOverride = await integrationsService.getMarketplaceConfig('ozon', {
    profileId: ctx.profileId ?? null,
    organizationId: ctx.organizationId ?? null
  });
  if (!integrationsService._hasOzonCredentials(ozonOverride)) {
    return { marketplace: 'ozon', ok: false, error: 'Кабинет Ozon не настроен для организации' };
  }

  try {
    const data = await integrationsService._ozonApiPost(
      '/v3/product/import',
      { items: [item] },
      {
        profileId: ctx.profileId ?? null,
        ozonOverride
      }
    );
    const taskId = data?.result?.task_id ?? data?.task_id ?? null;
    return {
      marketplace: 'ozon',
      ok: true,
      taskId,
      message: taskId
        ? `Задача обновления Ozon создана (task_id: ${taskId})`
        : 'Запрос на обновление Ozon отправлен'
    };
  } catch (e) {
    return { marketplace: 'ozon', ok: false, error: e?.message || String(e) };
  }
}

async function pushWildberriesCard(product, categoryMm, ctx) {
  const nmId = Number(product.sku_wb);
  if (!Number.isFinite(nmId) || nmId < 1) {
    return { marketplace: 'wb', ok: false, error: 'Некорректный nmId WB' };
  }
  const subjectId = Number(categoryMm?.wb ?? categoryMm?.wb_subject_id ?? 0);
  if (!Number.isFinite(subjectId) || subjectId < 1) {
    return {
      marketplace: 'wb',
      ok: false,
      error: 'В ERP-категории не задано сопоставление WB (subjectId)'
    };
  }

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

  const title =
    trimOrNull(product.mp_wb_name) ||
    trimOrNull(product.name) ||
    (existing?.title ? String(existing.title) : null);
  const description =
    trimOrNull(product.mp_wb_description) || trimOrNull(product.description) || '';
  const brand =
    trimOrNull(product.mp_wb_brand) || trimOrNull(product.brand) || trimOrNull(existing?.brand);
  const vendorCode =
    trimOrNull(product.mp_wb_vendor_code) ||
    trimOrNull(existing?.vendorCode) ||
    trimOrNull(product.sku);

  const card = {
    nmID: nmId,
    vendorCode: vendorCode || String(nmId),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(brand ? { brand } : {})
  };

  const chars = buildWbCharacteristics(product.wb_attributes);
  if (chars.length > 0) card.characteristics = chars;

  if (existing?.sizes && Array.isArray(existing.sizes) && existing.sizes.length > 0) {
    card.sizes = existing.sizes;
  }

  try {
    await integrationsService._wbContentApiPost('/content/v2/cards/update', [card], {
      profileId: ctx.profileId,
      organizationId: ctx.organizationId
    });
    return {
      marketplace: 'wb',
      ok: true,
      message: `Карточка WB (nmId ${nmId}) отправлена на обновление`
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

  const name = trimOrNull(product.mp_ym_name) || trimOrNull(product.name);
  const description = trimOrNull(product.mp_ym_description) || trimOrNull(product.description);

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

export default {
  pushProductCard,
  pushProductCardsBulk
};
