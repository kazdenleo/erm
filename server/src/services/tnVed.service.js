/**
 * TN VED Service — справочник кодов + привязки бренд/категория
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
import {
  findTnVedByCode,
  isKnownTnVedCode,
  searchTnVedCodes,
} from '../constants/tnVedCodes.js';

class TnVedService {
  constructor() {
    this.repo = null;
  }

  _getRepo() {
    if (!this.repo) {
      this.repo = repositoryFactory.getTnVedBindingsRepository();
    }
    return this.repo;
  }

  searchCodes(opts = {}) {
    return searchTnVedCodes(opts.q || opts.query || '', opts.limit);
  }

  getCode(code) {
    return findTnVedByCode(code);
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

  _normalizePayload(data = {}) {
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
    if (!isKnownTnVedCode(rawCode)) {
      const err = new Error('Код ТН ВЭД должен быть выбран из справочника');
      err.statusCode = 400;
      throw err;
    }
    const known = findTnVedByCode(rawCode);
    const tn_ved_code = known?.code || rawCode;

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
    const payload = this._normalizePayload(data);
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
    const payload = this._normalizePayload(merged);
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
}

export default new TnVedService();
