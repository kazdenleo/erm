/**
 * Подстановка кода ТН ВЭД категории в карточки товаров (ERP-атрибуты и характеристики МП).
 * Заполняются только пустые поля.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import { resolveOzonDescTypePair } from './productsExport.service.js';
import {
  collectTnVedMpKeys,
  fillEmptyTnVedKeys,
  isTnVedAttributeName,
  mpLinkIds,
  normalizeCategoryTnVedCode,
  normalizeTnVedDigits,
  parseMpLinksObject,
  storedTnVedValueForMarketplace,
} from '../utils/tnVedAttribute.js';

export { normalizeCategoryTnVedCode };

function parseMarketplaceMappings(raw) {
  let mm = raw;
  if (mm == null) return {};
  if (typeof mm === 'string') {
    try {
      mm = JSON.parse(mm || '{}');
    } catch {
      mm = {};
    }
  }
  if (typeof mm !== 'object' || Array.isArray(mm)) return {};
  return mm;
}

function parseJsonObject(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  return {};
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const x of list || []) {
    const s = x != null ? String(x).trim() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function mpValueIsEmptySql(column, keyParam) {
  return `(
    ${column} IS NULL
    OR jsonb_typeof(${column}) <> 'object'
    OR NOT (${column} ? ${keyParam})
    OR ${column}->${keyParam} = 'null'::jsonb
    OR ${column}->${keyParam} = '""'::jsonb
    OR (
      jsonb_typeof(${column}->${keyParam}) = 'string'
      AND TRIM(${column}->>${keyParam}) = ''
    )
    OR (
      jsonb_typeof(${column}->${keyParam}) = 'object'
      AND COALESCE(${column}->${keyParam}->>'value', '') = ''
      AND COALESCE(${column}->${keyParam}->>'dictionary_value_id', '') = ''
    )
  )`;
}

class TnVedProductApplyService {
  constructor() {
    this._targetsCache = new Map();
  }

  async resolveCategoryCode(categoryId) {
    const id = Number(categoryId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const r = await query('SELECT tn_ved_code FROM user_categories WHERE id = $1', [id]);
    return normalizeTnVedDigits(r.rows[0]?.tn_ved_code) || null;
  }

  async _loadCategoryRow(categoryId) {
    const id = Number(categoryId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const r = await query(
      'SELECT id, marketplace_mappings, tn_ved_code FROM user_categories WHERE id = $1',
      [id]
    );
    return r.rows[0] || null;
  }

  async _loadErpTnVedTargets(categoryId) {
    const r = await query(
      `SELECT pa.id, pa.name, COALESCE(ca.mp_links, '{}'::jsonb) AS mp_links
       FROM category_attributes ca
       JOIN product_attributes pa ON pa.id = ca.attribute_id
       WHERE ca.user_category_id = $1`,
      [categoryId]
    );
    const erpIds = [];
    const ozon = [];
    const wb = [];
    const ym = [];
    for (const row of r.rows || []) {
      const links = parseMpLinksObject(row.mp_links);
      const nameHit = isTnVedAttributeName(row.name);
      if (nameHit && row.id != null) erpIds.push(Number(row.id));
      if (!nameHit) continue;
      ozon.push(...mpLinkIds(links, 'ozon'));
      wb.push(...mpLinkIds(links, 'wb'));
      ym.push(...mpLinkIds(links, 'ym'));
    }
    return {
      erpIds: uniqueStrings(erpIds),
      ozon: uniqueStrings(ozon),
      wb: uniqueStrings(wb),
      ym: uniqueStrings(ym),
    };
  }

  async _loadMpSchemaKeys(categoryRow, opts = {}) {
    const mm = parseMarketplaceMappings(categoryRow?.marketplace_mappings);
    const keys = { ozon: [], wb: [], ym: [] };
    const fetchOpts = {
      forceRefresh: false,
      profileId: opts.profileId ?? null,
      organizationId: opts.organizationId ?? null,
    };

    try {
      let descId = Number(mm.ozon_description_category_id ?? mm.ozonDescriptionCategoryId ?? 0) || 0;
      let typeId = Number(mm.ozon_type_id ?? mm.ozonTypeId ?? 0) || 0;
      const composite = mm.ozon != null ? String(mm.ozon).trim() : '';
      if ((!descId || !typeId) && composite.includes('_')) {
        const [a, b] = composite.split('_');
        const d = Number(String(a || '').trim());
        const t = Number(String(b || '').trim());
        if (Number.isFinite(d) && d > 0) descId = d;
        if (Number.isFinite(t) && t > 0) typeId = t;
      }
      if (!descId || !typeId) {
        let flatOzon = [];
        try {
          flatOzon = await integrationsService.getOzonCategories({ dbOnly: true });
        } catch {
          flatOzon = [];
        }
        const pair = resolveOzonDescTypePair(mm, flatOzon);
        if (pair.descId > 0) descId = pair.descId;
        if (pair.typeId > 0) typeId = pair.typeId;
      }
      if (descId && typeId) {
        const list = await integrationsService.getOzonCategoryAttributes(descId, typeId, fetchOpts);
        keys.ozon = collectTnVedMpKeys(list, 'ozon');
      }
    } catch (e) {
      logger.warn('[TN VED apply] Ozon attributes skipped', { err: e?.message });
    }

    try {
      const subjectId = Number(mm.wb ?? mm.wb_subject_id ?? mm.wbSubjectId ?? 0) || 0;
      if (subjectId > 0) {
        const list = await integrationsService.getWildberriesCategoryAttributes(subjectId, fetchOpts);
        keys.wb = collectTnVedMpKeys(list, 'wb');
      }
    } catch (e) {
      logger.warn('[TN VED apply] WB attributes skipped', { err: e?.message });
    }

    try {
      const ymId = mm.ym != null ? String(mm.ym).trim().replace(/\s+/g, '') : '';
      if (ymId && /^\d+$/.test(ymId)) {
        const list = await integrationsService.getYandexCategoryContentParameters(ymId, fetchOpts);
        keys.ym = collectTnVedMpKeys(list, 'ym');
      }
    } catch (e) {
      logger.warn('[TN VED apply] YM attributes skipped', { err: e?.message });
    }

    return keys;
  }

  async _resolveTargets(categoryId, opts = {}) {
    const cacheKey = String(categoryId);
    const cached = this._targetsCache.get(cacheKey);
    if (cached) return cached;
    const category = await this._loadCategoryRow(categoryId);
    if (!category) return null;
    const erp = await this._loadErpTnVedTargets(categoryId);
    const schema = await this._loadMpSchemaKeys(category, opts);
    const result = {
      category,
      erpIds: erp.erpIds,
      ozonKeys: uniqueStrings([...erp.ozon, ...schema.ozon]),
      wbKeys: uniqueStrings([...erp.wb, ...schema.wb]),
      ymKeys: uniqueStrings([...erp.ym, ...schema.ym]),
    };
    this._targetsCache.set(cacheKey, result);
    setTimeout(() => this._targetsCache.delete(cacheKey), 60_000).unref?.();
    return result;
  }

  async enrichProductPayload(productData, opts = {}) {
    if (!productData || typeof productData !== 'object') return productData;
    const categoryId =
      opts.categoryId ?? productData.categoryId ?? productData.user_category_id;
    const code =
      (await this.resolveCategoryCode(categoryId)) ||
      normalizeTnVedDigits(opts.code);
    if (!code) return productData;

    const targets = await this._resolveTargets(categoryId, opts);
    if (!targets) return productData;

    if (targets.erpIds.length) {
      const hasValues =
        productData.attribute_values && typeof productData.attribute_values === 'object';
      if (!opts.onlyPresentMaps || hasValues) {
        const values = hasValues ? { ...productData.attribute_values } : {};
        let changed = false;
        for (const aid of targets.erpIds) {
          const key = String(aid);
          const cur = values[key] ?? values[aid];
          if (cur != null && String(cur).trim() !== '') continue;
          values[key] = code;
          changed = true;
        }
        if (changed) productData.attribute_values = values;
      }
    }

    const assignMp = (field, marketplace) => {
      const current = productData[field];
      if (
        opts.onlyPresentMaps &&
        (current == null || typeof current !== 'object' || Array.isArray(current))
      ) {
        return;
      }
      const keys =
        marketplace === 'ozon' ? targets.ozonKeys : marketplace === 'wb' ? targets.wbKeys : targets.ymKeys;
      productData[field] = fillEmptyTnVedKeys(
        current,
        keys,
        storedTnVedValueForMarketplace(marketplace, code)
      );
    };
    assignMp('ozon_attributes', 'ozon');
    assignMp('wb_attributes', 'wb');
    assignMp('ym_attributes', 'ym');
    return productData;
  }

  async _applyMpKeys(categoryId, column, keys, storedValue) {
    if (!keys.length) return 0;
    let total = 0;
    for (const key of keys) {
      const patch = JSON.stringify({ [key]: storedValue });
      const r = await query(
        `UPDATE products
         SET ${column} = COALESCE(${column}, '{}'::jsonb) || $3::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_category_id = $1
           AND ${mpValueIsEmptySql(column, '$2')}
           AND (${column} IS NULL OR jsonb_typeof(${column}) = 'object')`,
        [categoryId, key, patch]
      );
      total += r.rowCount || 0;
    }
    return total;
  }

  async applyToCategoryProducts(categoryId, code, opts = {}) {
    const normalized = normalizeCategoryTnVedCode(code);
    if (!normalized) return { ok: true, skipped: true };
    const id = Number(categoryId);
    if (!Number.isFinite(id) || id <= 0) return { ok: false };
    this._targetsCache.delete(String(id));

    const targets = await this._resolveTargets(id, opts);
    if (!targets) return { ok: false };

    let erpUpdated = 0;
    for (const attrId of targets.erpIds) {
      const r = await query(
        `INSERT INTO product_attribute_values (product_id, attribute_id, value, is_manual)
         SELECT p.id, $2, $3, false
         FROM products p
         WHERE p.user_category_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM product_attribute_values pav
             WHERE pav.product_id = p.id
               AND pav.attribute_id = $2
               AND pav.value IS NOT NULL
               AND TRIM(pav.value) <> ''
           )
         ON CONFLICT (product_id, attribute_id)
         DO UPDATE SET value = EXCLUDED.value
         WHERE product_attribute_values.value IS NULL
            OR TRIM(product_attribute_values.value) = ''`,
        [id, Number(attrId), normalized]
      );
      erpUpdated += r.rowCount || 0;
    }

    const ozonUpdated = await this._applyMpKeys(
      id,
      'ozon_attributes',
      targets.ozonKeys,
      storedTnVedValueForMarketplace('ozon', normalized)
    );
    const wbUpdated = await this._applyMpKeys(
      id,
      'wb_attributes',
      targets.wbKeys,
      storedTnVedValueForMarketplace('wb', normalized)
    );
    const ymUpdated = await this._applyMpKeys(
      id,
      'ym_attributes',
      targets.ymKeys,
      storedTnVedValueForMarketplace('ym', normalized)
    );

    logger.info('[TN VED apply] category products updated', {
      categoryId: id,
      code: normalized,
      erpUpdated,
      ozonUpdated,
      wbUpdated,
      ymUpdated,
    });
    return { ok: true, erpUpdated, ozonUpdated, wbUpdated, ymUpdated };
  }
}

export default new TnVedProductApplyService();
