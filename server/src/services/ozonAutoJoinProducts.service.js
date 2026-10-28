/**
 * Автообъединение карточек Ozon: одинаковый «Артикул для объединения» (attr 9048)
 * для товаров с одним type_id и брендом (attr 85).
 * Логика перенесена из Google Apps Script; Join SKU стабилен между прогонами.
 */

import crypto from 'crypto';
import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import {
  isOzonAutoJoinProductsEnabled,
  pickOzonCredentials,
  OZON_JOIN_SKU_ATTR_ID,
  OZON_BRAND_ATTR_ID,
} from '../utils/ozonAutoJoinProducts.js';

const ATTR_BATCH = 50;
const UPDATE_BATCH = 50;
const LIST_LIMIT = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateJoinSku() {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

function attrValue(attributes, attributeId) {
  if (!Array.isArray(attributes)) return null;
  const id = Number(attributeId);
  for (const attr of attributes) {
    if (Number(attr?.id) !== id) continue;
    const values = attr.values;
    if (!Array.isArray(values) || values.length === 0) return null;
    const v = values[0]?.value;
    return v != null && String(v).trim() !== '' ? String(v).trim() : null;
  }
  return null;
}

function ozonApiOptsFromScope(scope) {
  return {
    profileId: scope?.profileId ?? null,
    organizationId: scope?.organizationId ?? null,
    ozonOverride: {
      client_id: scope.client_id,
      api_key: scope.api_key,
    },
  };
}

async function listAllProductRefs(apiOpts) {
  const acc = [];
  let lastId = '';
  for (let safety = 0; safety < 500; safety++) {
    const body = {
      filter: { visibility: 'ALL' },
      limit: LIST_LIMIT,
    };
    if (lastId) body.last_id = lastId;

    const data = await integrationsService._ozonApiPost('/v3/product/list', body, apiOpts);
    const result = data?.result ?? data;
    const items = Array.isArray(result?.items) ? result.items : [];
    for (const it of items) {
      const productId = it?.product_id ?? it?.productId;
      const offerId = it?.offer_id ?? it?.offerId;
      if (productId == null && (offerId == null || String(offerId).trim() === '')) continue;
      acc.push({
        product_id: productId != null ? Number(productId) : null,
        offer_id: offerId != null ? String(offerId).trim() : null,
      });
    }
    const next = result?.last_id ?? result?.lastId;
    if (next != null && String(next).trim() !== '') {
      lastId = String(next).trim();
    } else {
      lastId = '';
    }
    if (items.length < LIST_LIMIT || !lastId) break;
  }
  return acc;
}

async function fetchAttributesBatch(productIds, apiOpts) {
  const ids = productIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];

  const body = {
    filter: {
      product_id: ids,
      visibility: 'ALL',
    },
    limit: ids.length,
    sort_dir: 'ASC',
  };

  let data;
  try {
    data = await integrationsService._ozonApiPost('/v4/product/info/attributes', body, apiOpts);
  } catch (e) {
    if (String(e?.message || '').includes('404')) {
      data = await integrationsService._ozonApiPost('/v4/products/info/attributes', body, apiOpts);
    } else {
      throw e;
    }
  }

  const raw = data?.result?.items ?? data?.result ?? data?.items ?? [];
  return Array.isArray(raw) ? raw : [];
}

async function loadProductsWithAttrs(apiOpts) {
  const refs = await listAllProductRefs(apiOpts);
  const byId = new Map();
  for (const ref of refs) {
    if (ref.product_id != null && Number.isFinite(ref.product_id) && ref.product_id > 0) {
      byId.set(ref.product_id, ref);
    }
  }
  const ids = [...byId.keys()];
  const products = [];

  for (let i = 0; i < ids.length; i += ATTR_BATCH) {
    const chunk = ids.slice(i, i + ATTR_BATCH);
    const attrsList = await fetchAttributesBatch(chunk, apiOpts);
    const byAttrId = new Map();
    for (const row of attrsList) {
      const pid = Number(row?.id ?? row?.product_id);
      if (Number.isFinite(pid) && pid > 0) byAttrId.set(pid, row);
    }

    for (const pid of chunk) {
      const ref = byId.get(pid);
      const row = byAttrId.get(pid) || {};
      const attributes = Array.isArray(row.attributes) ? row.attributes : [];
      const typeIdRaw = row.type_id ?? row.typeId;
      const typeId =
        typeIdRaw != null && String(typeIdRaw).trim() !== '' && Number(typeIdRaw) !== 0
          ? String(typeIdRaw).trim()
          : 'НЕТ_ТИПА';
      const brand = attrValue(attributes, OZON_BRAND_ATTR_ID) || 'БЕЗ_БРЕНДА';
      const joinSku = attrValue(attributes, OZON_JOIN_SKU_ATTR_ID) || '';
      products.push({
        product_id: pid,
        offer_id: String(row.offer_id ?? ref?.offer_id ?? '').trim() || null,
        type_id: typeId,
        brand,
        joinSku,
        attributes,
      });
    }

    if (i + ATTR_BATCH < ids.length) await sleep(300);
  }

  return products;
}

function groupByTypeAndBrand(products) {
  const groups = new Map();
  for (const p of products) {
    const key = `${p.type_id}\0${p.brand}`;
    if (!groups.has(key)) {
      groups.set(key, {
        type_id: p.type_id,
        brand: p.brand,
        products: [],
      });
    }
    groups.get(key).products.push(p);
  }
  return groups;
}

/** Стабильный Join SKU: самый частый уже заданный, иначе новый. */
function resolveGroupJoinSku(groupProducts) {
  const counts = new Map();
  for (const p of groupProducts) {
    const j = String(p.joinSku || '').trim();
    if (!j) continue;
    counts.set(j, (counts.get(j) || 0) + 1);
  }
  if (counts.size === 0) return generateJoinSku();
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

async function updateJoinSkuBatch(items, joinSku, apiOpts) {
  if (!items.length) return { ok: true, task_id: null };

  const payloadItems = items
    .filter((p) => p.offer_id)
    .map((p) => ({
      offer_id: p.offer_id,
      ...(p.product_id != null ? { product_id: Number(p.product_id) } : {}),
      attributes: [
        {
          complex_id: 0,
          id: OZON_JOIN_SKU_ATTR_ID,
          values: [{ dictionary_value_id: 0, value: joinSku }],
        },
      ],
    }));

  if (!payloadItems.length) return { ok: false, error: 'no_offer_id' };

  const data = await integrationsService._ozonApiPost(
    '/v1/product/attributes/update',
    { items: payloadItems },
    apiOpts
  );
  const taskId = data?.result?.task_id ?? data?.task_id ?? null;
  return { ok: true, task_id: taskId };
}

/**
 * Прогон для одного кабинета (client_id + api_key).
 * Группы из 1 товара пропускаем — объединять нечего.
 */
export async function runOzonAutoJoinProductsForScope(scope) {
  const client_id = String(scope?.client_id || '').trim();
  const api_key = String(scope?.api_key || '').trim();
  if (!client_id || !api_key) {
    return { ok: false, error: 'Нет учётных данных Ozon' };
  }

  const apiOpts = ozonApiOptsFromScope({ ...scope, client_id, api_key });
  const products = await loadProductsWithAttrs(apiOpts);
  const groups = groupByTypeAndBrand(products);

  const summary = {
    ok: true,
    productsTotal: products.length,
    groupsTotal: groups.size,
    groupsWithMerge: 0,
    productsUpdated: 0,
    productsSkipped: 0,
    errors: 0,
    tasks: [],
  };

  for (const group of groups.values()) {
    if (group.products.length < 2) {
      summary.productsSkipped += group.products.length;
      continue;
    }

    summary.groupsWithMerge += 1;
    const joinSku = resolveGroupJoinSku(group.products);
    const toUpdate = group.products.filter(
      (p) => p.offer_id && String(p.joinSku || '').trim() !== joinSku
    );

    if (!toUpdate.length) {
      summary.productsSkipped += group.products.length;
      continue;
    }

    for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH) {
      const batch = toUpdate.slice(i, i + UPDATE_BATCH);
      try {
        const upd = await updateJoinSkuBatch(batch, joinSku, apiOpts);
        if (upd.ok) {
          summary.productsUpdated += batch.length;
          if (upd.task_id) summary.tasks.push(upd.task_id);
        } else {
          summary.errors += batch.length;
        }
      } catch (e) {
        summary.errors += batch.length;
        logger.warn('[OzonAutoJoin] attributes/update failed', {
          brand: group.brand,
          type_id: group.type_id,
          message: e?.message || String(e),
        });
      }
      if (i + UPDATE_BATCH < toUpdate.length) await sleep(500);
    }

    summary.productsSkipped += group.products.length - toUpdate.length;
    await sleep(400);
  }

  logger.info('[OzonAutoJoin] done', {
    client_id,
    productsTotal: summary.productsTotal,
    groupsWithMerge: summary.groupsWithMerge,
    productsUpdated: summary.productsUpdated,
    errors: summary.errors,
  });

  return summary;
}

export async function listOzonConfigsWithAutoJoinProducts() {
  if (!integrationsService.usePostgreSQL) return [];

  const { query } = await import('../config/database.js');
  const scopes = [];
  const seen = new Set();

  const pushScope = (cfg, meta = {}) => {
    if (!isOzonAutoJoinProductsEnabled(cfg)) return;
    const { client_id, api_key } = pickOzonCredentials(cfg);
    if (!client_id || !api_key) return;
    const dedupeKey = `${String(client_id).trim()}:${String(api_key).trim()}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    scopes.push({
      client_id: String(client_id).trim(),
      api_key: String(api_key).trim(),
      organizationId: meta.organizationId ?? null,
      profileId: meta.profileId ?? null,
    });
  };

  try {
    const cabResult = await query(
      `SELECT mc.organization_id, mc.config, o.profile_id
       FROM marketplace_cabinets mc
       LEFT JOIN organizations o ON o.id = mc.organization_id
       WHERE mc.marketplace_type = 'ozon'
         AND COALESCE(mc.is_active, true) = true
       ORDER BY mc.id ASC`
    );
    for (const row of cabResult.rows || []) {
      const parsed =
        integrationsService._safeParseJsonMaybe(row.config) ??
        (row.config && typeof row.config === 'object' ? row.config : null);
      pushScope(parsed, {
        organizationId: row.organization_id != null ? Number(row.organization_id) : null,
        profileId: row.profile_id != null ? Number(row.profile_id) : null,
      });
    }
  } catch (e) {
    logger.warn('[OzonAutoJoin] list cabinets failed', e?.message || e);
  }

  try {
    const intResult = await query(
      `SELECT profile_id, organization_id, config
       FROM integrations
       WHERE code = 'ozon' AND type = 'marketplace' AND is_active = true
       ORDER BY updated_at DESC NULLS LAST, id DESC`
    );
    for (const row of intResult.rows || []) {
      const parsed =
        integrationsService._safeParseJsonMaybe(row.config) ??
        (row.config && typeof row.config === 'object' ? row.config : null);
      pushScope(parsed, {
        organizationId: row.organization_id != null ? Number(row.organization_id) : null,
        profileId: row.profile_id != null ? Number(row.profile_id) : null,
      });
    }
  } catch (e) {
    logger.warn('[OzonAutoJoin] list integrations failed', e?.message || e);
  }

  return scopes;
}

export async function runOzonAutoJoinProductsForAllEnabled() {
  const scopes = await listOzonConfigsWithAutoJoinProducts();
  const results = [];
  for (const scope of scopes) {
    try {
      const result = await runOzonAutoJoinProductsForScope(scope);
      results.push({ ...result, organizationId: scope.organizationId, profileId: scope.profileId });
    } catch (e) {
      logger.error('[OzonAutoJoin] scope failed', e?.message || e);
      results.push({
        ok: false,
        error: e?.message || String(e),
        organizationId: scope.organizationId,
        profileId: scope.profileId,
      });
    }
  }
  return {
    ok: results.every((r) => r.ok !== false),
    processed: results.length,
    results,
  };
}

export async function runOzonAutoJoinProductsForOrgScope({ profileId = null, organizationId = null } = {}) {
  const cfg = await integrationsService.getMarketplaceConfig('ozon', { profileId, organizationId });
  if (!isOzonAutoJoinProductsEnabled(cfg)) {
    return { ok: false, error: 'Автообъединение товаров не включено в настройках Ozon' };
  }
  const { client_id, api_key } = pickOzonCredentials(cfg);
  if (!client_id || !api_key) {
    return { ok: false, error: 'Ozon не настроен для выбранной организации' };
  }
  return runOzonAutoJoinProductsForScope({
    client_id,
    api_key,
    profileId,
    organizationId,
  });
}

export default {
  runOzonAutoJoinProductsForScope,
  runOzonAutoJoinProductsForAllEnabled,
  runOzonAutoJoinProductsForOrgScope,
  listOzonConfigsWithAutoJoinProducts,
};
