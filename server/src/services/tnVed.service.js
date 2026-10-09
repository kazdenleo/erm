/**
 * TN VED Service — справочник кодов + привязки бренд/категория
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import tnVedDirectoryService from './tnVedDirectory.service.js';
import { resolveOzonDescTypePair } from './productsExport.service.js';
import { findTnVedByCode } from '../constants/tnVedCodes.js';
import {
  collectTnVedMpKeys,
  matchOzonTnVedDictEntry,
  normalizeTnVedDigits,
} from '../utils/tnVedAttribute.js';

const COMPAT_CACHE_MS = 60 * 60 * 1000;

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
  return mm && typeof mm === 'object' && !Array.isArray(mm) ? mm : {};
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

class TnVedService {
  constructor() {
    this.repo = null;
    this._compatCache = new Map();
  }

  _getRepo() {
    if (!this.repo) {
      this.repo = repositoryFactory.getTnVedBindingsRepository();
    }
    return this.repo;
  }

  async searchCodes(opts = {}) {
    return tnVedDirectoryService.search({ q: opts.q || opts.query || '', limit: opts.limit });
  }

  async getCode(code) {
    return tnVedDirectoryService.getCode(code);
  }

  async getDirectoryInfo() {
    return tnVedDirectoryService.getMeta();
  }

  async getBindings(options = {}) {
    return await this._getRepo().findAll(options);
  }

  async getBindingById(id) {
    const item = await this._getRepo().findById(id);
    if (!item) {
      const err = new Error('Привязка ТН ВЭД не найдена');
      err.statusCode = 404;
      throw err;
    }
    return item;
  }

  async _normalizePayload(data = {}, opts = {}) {
    const brand_id = data.brand_id ?? data.brandId ?? null;
    if (brand_id == null || brand_id === '') {
      const err = new Error('Бренд обязателен');
      err.statusCode = 400;
      throw err;
    }

    const rawCode = String(data.tn_ved_code ?? data.tnVedCode ?? '').replace(/\D/g, '');
    if (!rawCode) {
      const err = new Error('Выберите код ТН ВЭД из списка');
      err.statusCode = 400;
      throw err;
    }
    const tn_ved_code = findTnVedByCode(rawCode)?.code || rawCode;
    await tnVedDirectoryService.assertActiveCode(tn_ved_code, { allowCode: opts.allowCode });

    const user_category_ids = (
      Array.isArray(data.user_category_ids)
        ? data.user_category_ids
        : Array.isArray(data.userCategoryIds)
          ? data.userCategoryIds
          : []
    )
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (user_category_ids.length === 0) {
      const err = new Error('Нужна хотя бы одна категория (бренд и категория указываются только вместе)');
      err.statusCode = 400;
      throw err;
    }

    return { brand_id, tn_ved_code, user_category_ids };
  }

  async createBinding(data) {
    const payload = await this._normalizePayload(data);
    const created = await this._getRepo().create(payload);
    await this._syncDenorm(created);
    return created;
  }

  async updateBinding(id, data) {
    const existing = await this._getRepo().findById(id);
    if (!existing) {
      const err = new Error('Привязка ТН ВЭД не найдена');
      err.statusCode = 404;
      throw err;
    }

    const touchingBinding =
      data.hasOwnProperty('brand_id') ||
      data.hasOwnProperty('brandId') ||
      data.hasOwnProperty('tn_ved_code') ||
      data.hasOwnProperty('tnVedCode') ||
      data.hasOwnProperty('user_category_ids') ||
      data.hasOwnProperty('userCategoryIds');

    if (!touchingBinding) {
      return existing;
    }

    const merged = {
      brand_id: data.brand_id ?? data.brandId ?? existing.brand_id,
      tn_ved_code: data.tn_ved_code ?? data.tnVedCode ?? existing.tn_ved_code,
      user_category_ids:
        data.user_category_ids ??
        data.userCategoryIds ??
        existing.user_category_ids,
    };
    const payload = await this._normalizePayload(merged, { allowCode: existing.tn_ved_code });
    const updated = await this._getRepo().update(id, payload);
    await this._syncDenorm(updated);
    return updated;
  }

  async deleteBinding(id) {
    const ok = await this._getRepo().delete(id);
    if (!ok) {
      const err = new Error('Привязка ТН ВЭД не найдена');
      err.statusCode = 404;
      throw err;
    }
    return true;
  }

  async _syncDenorm(binding) {
    if (!binding || !repositoryFactory.isUsingPostgreSQL()) return;
    const code = binding.tn_ved_code || null;
    try {
      if (binding.brand_id) {
        await query(
          `UPDATE brands SET tn_ved_code = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [code, binding.brand_id]
        );
      }
      // Код категории задаётся в настройках категории и не перезаписывается привязками бренд+категория.
    } catch (_) {
      // не ломаем основной поток
    }
  }

  async _cached(key, fn) {
    const hit = this._compatCache.get(key);
    if (hit && Date.now() - hit.at < COMPAT_CACHE_MS) return hit.value;
    const value = await fn();
    if (value.status !== 'error') this._compatCache.set(key, { at: Date.now(), value });
    return value;
  }

  async _checkWb(code, subjectId, scope) {
    if (!subjectId) return { status: 'no_mapping' };
    return this._cached(`wb:${scope.organizationId || scope.profileId || ''}:${subjectId}:${code}`, async () => {
      try {
        const list = await integrationsService.getWildberriesTnVedCodes(subjectId, code, scope);
        const hit = list.find((x) => x.tnved === code);
        if (hit) return { status: 'ok', isKiz: hit.isKiz };
        return { status: 'not_allowed', subjectId };
      } catch (e) {
        logger.warn('[TN VED] WB compatibility check failed', { subjectId, code, err: e?.message });
        return { status: 'error', message: e?.message || 'Ошибка запроса к WB' };
      }
    });
  }

  async _checkOzon(code, descId, typeId, scope) {
    if (!descId || !typeId) return { status: 'no_mapping' };
    return this._cached(`ozon:${scope.organizationId || scope.profileId || ''}:${descId}:${typeId}:${code}`, async () => {
      try {
        const attrs = await integrationsService.getOzonCategoryAttributes(descId, typeId, scope);
        const attrIds = collectTnVedMpKeys(attrs, 'ozon');
        if (!attrIds.length) return { status: 'no_attribute' };
        const found = await integrationsService.searchOzonAttributeValues(attrIds[0], descId, typeId, code, scope);
        const entry = matchOzonTnVedDictEntry(found, code);
        if (entry) return { status: 'ok', value: String(entry.value ?? entry.name ?? '') };
        return { status: 'not_allowed' };
      } catch (e) {
        logger.warn('[TN VED] Ozon compatibility check failed', { descId, typeId, code, err: e?.message });
        return { status: 'error', message: e?.message || 'Ошибка запроса к Ozon' };
      }
    });
  }

  /**
   * Подходит ли код ТН ВЭД для предмета WB и типа товара Ozon категории.
   * Параметры сопоставления из формы имеют приоритет над сохранёнными в категории.
   */
  async checkMarketplaceCompatibility(opts = {}) {
    const code = normalizeTnVedDigits(opts.code);
    if (code.length !== 10) {
      const err = new Error('Код ТН ВЭД — 10 цифр');
      err.statusCode = 400;
      throw err;
    }
    const scope = {
      profileId: opts.profileId ?? null,
      organizationId: opts.organizationId ?? null,
    };

    let mm = {};
    const categoryId = positiveInt(opts.userCategoryId);
    if (categoryId) {
      const r = await query('SELECT profile_id, marketplace_mappings FROM user_categories WHERE id = $1', [categoryId]);
      const row = r.rows[0];
      if (row && (scope.profileId == null || Number(row.profile_id) === Number(scope.profileId))) {
        mm = parseMarketplaceMappings(row.marketplace_mappings);
      }
    }

    const wbSubjectId = positiveInt(opts.wbSubjectId) || positiveInt(mm.wb ?? mm.wb_subject_id ?? mm.wbSubjectId);

    let descId = positiveInt(opts.ozonDescId);
    let typeId = positiveInt(opts.ozonTypeId);
    if (!descId || !typeId) {
      descId = positiveInt(mm.ozon_description_category_id ?? mm.ozonDescriptionCategoryId);
      typeId = positiveInt(mm.ozon_type_id ?? mm.ozonTypeId);
      const composite = mm.ozon != null ? String(mm.ozon).trim() : '';
      if ((!descId || !typeId) && composite.includes('_')) {
        const [a, b] = composite.split('_');
        descId = descId || positiveInt(a);
        typeId = typeId || positiveInt(b);
      }
      if ((!descId || !typeId) && Object.keys(mm).length) {
        let flatOzon = [];
        try {
          flatOzon = await integrationsService.getOzonCategories({ dbOnly: true });
        } catch {
          flatOzon = [];
        }
        const pair = resolveOzonDescTypePair(mm, flatOzon);
        descId = descId || pair.descId || 0;
        typeId = typeId || pair.typeId || 0;
      }
    }

    const ymCategoryId = positiveInt(opts.ymCategoryId) || positiveInt(mm.ym ?? mm.yandex);

    const [directory, wb, ozon] = await Promise.all([
      tnVedDirectoryService.getCode(code),
      this._checkWb(code, wbSubjectId, scope),
      this._checkOzon(code, descId, typeId, scope),
    ]);
    // Я.Маркет не привязывает ТН ВЭД к категории: код уходит полем оффера commodityCodes.
    const ym = ymCategoryId ? { status: 'ok', value: 'Передаётся в карточку товара (commodityCodes)' } : { status: 'no_mapping' };
    return {
      code,
      directory: directory ? { found: true, active: directory.active, name: directory.name, positionName: directory.positionName || null } : { found: false },
      wb,
      ozon,
      ym,
    };
  }
}

export default new TnVedService();
