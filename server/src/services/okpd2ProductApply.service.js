/**
 * ОКПД2 карточки ↔ характеристики «ОКПД» маркетплейсов категории.
 * Код в карточке — источник: при сохранении он уходит во все найденные характеристики МП.
 * Пустой код карточки подхватывается из характеристик МП (загрузка с МП, импорт, массовая правка).
 */

import { query } from '../config/database.js';
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

    if (!code && !cleared && !hasMpMaps) return payload;
    if (code && !hasCode && !categoryChanged) return payload;

    const keys = await this._categoryMpKeys(categoryId, opts);
    if (!keys) return payload;

    if (code || cleared) {
      for (const [mp, field] of Object.entries(MP_ATTR_FIELDS)) {
        const mpKeys = keys[mp] || [];
        if (!mpKeys.length) continue;
        const patch = isPlainObject(payload[field]) ? { ...payload[field] } : {};
        for (const key of mpKeys) patch[key] = code ? storedOkpd2ValueForMarketplace(mp, code) : '';
        payload[field] = patch;
      }
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
    return payload;
  }
}

export default new Okpd2ProductApplyService();
