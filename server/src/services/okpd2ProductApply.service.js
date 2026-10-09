/**
 * ОКПД2 карточки ↔ характеристики «ОКПД» маркетплейсов категории.
 * Код в карточке — источник: при сохранении он уходит во все найденные характеристики МП.
 * Пустой код карточки подхватывается из характеристик МП (загрузка с МП, импорт, массовая правка).
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import { loadCategoryMpAttrKeys } from './tnVedProductApply.service.js';
import {
  collectOkpd2MpKeys,
  normalizeOkpd2Code,
  okpd2FromMpStoredValue,
  storedOkpd2ValueForMarketplace,
} from '../utils/okpd2.js';

const MP_ATTR_FIELDS = { wb: 'wb_attributes', ym: 'ym_attributes', ozon: 'ozon_attributes' };

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

class Okpd2ProductApplyService {
  constructor() {
    this._keysCache = new Map();
  }

  async _categoryMpKeys(categoryId, opts) {
    const id = Number(categoryId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const cacheKey = String(id);
    if (this._keysCache.has(cacheKey)) return this._keysCache.get(cacheKey);
    const r = await query('SELECT id, marketplace_mappings FROM user_categories WHERE id = $1', [id]);
    if (!r.rows[0]) return null;
    const keys = await loadCategoryMpAttrKeys(r.rows[0], collectOkpd2MpKeys, {
      profileId: opts.profileId ?? null,
      organizationId: opts.organizationId ?? null,
      logTag: '[OKPD2 apply]',
    });
    this._keysCache.set(cacheKey, keys);
    setTimeout(() => this._keysCache.delete(cacheKey), 60_000).unref?.();
    return keys;
  }

  /**
   * Дополняет данные create/update (меняет объект на месте).
   * @param {object} payload
   * @param {{ existing?: object|null, profileId?: number, organizationId?: number }} opts
   */
  async syncPayload(payload, opts = {}) {
    if (!isPlainObject(payload)) return payload;
    const existing = opts.existing || null;
    let hasCode = Object.prototype.hasOwnProperty.call(payload, 'okpd2_code');
    if (hasCode) {
      const normalized = normalizeOkpd2Code(payload.okpd2_code);
      if (normalized === null) {
        delete payload.okpd2_code;
        hasCode = false;
      } else {
        payload.okpd2_code = normalized || null;
      }
    }
    const prevCode = normalizeOkpd2Code(existing?.okpd2_code) || '';
    const code = hasCode ? payload.okpd2_code || '' : prevCode;

    const payloadCategory = payload.categoryId ?? payload.user_category_id;
    const categoryId = payloadCategory ?? existing?.user_category_id;
    const categoryChanged =
      !!existing && payloadCategory !== undefined && String(payloadCategory ?? '') !== String(existing.user_category_id ?? '');
    const hasMpMaps = Object.values(MP_ATTR_FIELDS).some((f) => isPlainObject(payload[f]));
    const cleared = hasCode && !code && !!prevCode;
    const inheritFromCategory =
      !code && !cleared && categoryId != null && categoryId !== '' && (!existing || categoryChanged);

    if (!code && !cleared && !hasMpMaps && !inheritFromCategory) return payload;
    if (code && !hasCode && !categoryChanged) return payload;

    const keys = await this._categoryMpKeys(categoryId, opts);
    if (!keys) return payload;

    if (code || cleared) {
      this._writeMpKeys(payload, keys, code);
      return payload;
    }

    for (const [mp, field] of Object.entries(MP_ATTR_FIELDS)) {
      const map = payload[field];
      if (!isPlainObject(map)) continue;
      for (const key of keys[mp] || []) {
        const fromMp = okpd2FromMpStoredValue(map[key]);
        if (fromMp) {
          payload.okpd2_code = fromMp;
          return payload;
        }
      }
    }

    if (inheritFromCategory) {
      const categoryCode = await this._categoryOkpd2Code(categoryId);
      if (categoryCode) {
        payload.okpd2_code = categoryCode;
        this._writeMpKeys(payload, keys, categoryCode);
      }
    }
    return payload;
  }

  _writeMpKeys(payload, keys, code) {
    for (const [mp, field] of Object.entries(MP_ATTR_FIELDS)) {
      const mpKeys = keys[mp] || [];
      if (!mpKeys.length) continue;
      const patch = isPlainObject(payload[field]) ? { ...payload[field] } : {};
      for (const key of mpKeys) patch[key] = code ? storedOkpd2ValueForMarketplace(mp, code) : '';
      payload[field] = patch;
    }
  }

  async _categoryOkpd2Code(categoryId) {
    const id = Number(categoryId);
    if (!Number.isFinite(id) || id <= 0) return '';
    const r = await query('SELECT okpd2_code FROM user_categories WHERE id = $1', [id]);
    return normalizeOkpd2Code(r.rows[0]?.okpd2_code) || '';
  }

  /** Товары категории, у которых в карточке стоит этот код ОКПД2. */
  async listCategoryProductIdsWithCode(categoryId, code) {
    const id = Number(categoryId);
    const normalized = normalizeOkpd2Code(code);
    if (!Number.isFinite(id) || id <= 0 || !normalized) return [];
    const r = await query('SELECT id FROM products WHERE user_category_id = $1 AND okpd2_code = $2', [
      id,
      normalized,
    ]);
    return r.rows.map((row) => Number(row.id)).filter((n) => Number.isFinite(n) && n > 0);
  }

  /**
   * Код категории → товары категории с пустым ОКПД2 (или с прежним кодом категории)
   * и характеристики ОКПД маркетплейсов у всех товаров категории с этим кодом.
   * @returns {Promise<{ ok: boolean, skipped?: boolean, productIds?: number[], erpUpdated?: number, mpUpdated?: number }>}
   */
  async applyToCategoryProducts(categoryId, code, opts = {}) {
    const normalized = normalizeOkpd2Code(code);
    if (!normalized) return { ok: true, skipped: true };
    const id = Number(categoryId);
    if (!Number.isFinite(id) || id <= 0) return { ok: false };
    const previousCode = normalizeOkpd2Code(opts.previousCode) || null;

    const touched = new Set();
    const erp = await query(
      `UPDATE products
       SET okpd2_code = $2, updated_at = CURRENT_TIMESTAMP
       WHERE user_category_id = $1
         AND (okpd2_code IS NULL OR BTRIM(okpd2_code) = '' OR okpd2_code = $3)
         AND okpd2_code IS DISTINCT FROM $2
       RETURNING id`,
      [id, normalized, previousCode]
    );
    for (const row of erp.rows) touched.add(Number(row.id));

    this._keysCache.delete(String(id));
    const keys = await this._categoryMpKeys(id, opts);
    let mpUpdated = 0;
    const columns = keys
      ? Object.entries(MP_ATTR_FIELDS).filter(([mp]) => (keys[mp] || []).length)
      : [];
    if (columns.length) {
      const r = await query(
        `SELECT id, ozon_attributes, wb_attributes, ym_attributes
         FROM products WHERE user_category_id = $1 AND okpd2_code = $2`,
        [id, normalized]
      );
      for (const row of r.rows) {
        const sets = [];
        const params = [row.id];
        for (const [mp, field] of columns) {
          const current = isPlainObject(row[field]) ? row[field] : {};
          const patch = {};
          for (const key of keys[mp]) {
            if (okpd2FromMpStoredValue(current[key]) !== normalized) {
              patch[key] = storedOkpd2ValueForMarketplace(mp, normalized);
            }
          }
          if (!Object.keys(patch).length) continue;
          params.push(JSON.stringify(patch));
          sets.push(`${field} = COALESCE(${field}, '{}'::jsonb) || $${params.length}::jsonb`);
        }
        if (!sets.length) continue;
        await query(
          `UPDATE products SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          params
        );
        mpUpdated += 1;
        touched.add(Number(row.id));
      }
    }

    const productIds = [...touched].filter((n) => Number.isFinite(n) && n > 0);
    logger.info('[OKPD2 apply] category products updated', {
      categoryId: id,
      code: normalized,
      previousCode,
      erpUpdated: erp.rowCount || 0,
      mpUpdated,
      products: productIds.length,
    });
    return { ok: true, erpUpdated: erp.rowCount || 0, mpUpdated, productIds };
  }
}

export default new Okpd2ProductApplyService();
