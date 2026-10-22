/**
 * Certificates Service
 * Привязка: бренд + конкретные товары.
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import {
  mergeExistingCertKeys,
  wbCertAttributePatch,
} from '../utils/certProductAttributes.js';

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeIdList(raw) {
  const arr = Array.isArray(raw) ? raw : raw != null && raw !== '' ? [raw] : [];
  return arr
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
}

class CertificatesService {
  constructor() {
    this.repo = repositoryFactory.getCertificatesRepository();
  }

  _profileOpts(profileId) {
    if (profileId == null || profileId === '') return {};
    return { profileId };
  }

  async getAll(options = {}) {
    return await this.repo.findAll(options);
  }

  async getById(id, options = {}) {
    const item = await this.repo.findById(id, this._profileOpts(options.profileId ?? options.profile_id));
    if (!item) {
      throw httpError('Сертификат не найден', 404);
    }
    return item;
  }

  async getProductsWithoutCertificate(options = {}) {
    return await this.repo.findProductsWithoutCertificate(options);
  }

  _normalizePayload(data = {}) {
    const certificate_number = String(data.certificate_number ?? data.certificateNumber ?? '').trim();
    if (!certificate_number) {
      throw httpError('Номер сертификата обязателен', 400);
    }

    const brand_id = data.brand_id ?? data.brandId ?? null;
    if (brand_id == null || brand_id === '') {
      throw httpError('Бренд обязателен', 400);
    }

    // Товары необязательны — сертификат можно сохранить без привязки.
    const product_ids = normalizeIdList(data.product_ids ?? data.productIds);

    // Категории больше не обязательны; сохраняем если передали (совместимость).
    const user_category_ids = normalizeIdList(
      data.user_category_ids ??
        data.userCategoryIds ??
        (data.user_category_id != null || data.userCategoryId != null
          ? [data.user_category_id ?? data.userCategoryId]
          : [])
    );

    return {
      certificate_number,
      brand_id,
      product_ids,
      user_category_id: user_category_ids[0] ?? null,
      user_category_ids,
      document_type: data.document_type ?? data.documentType ?? 'certificate',
      photo_url: data.photo_url ?? data.photoUrl ?? null,
      valid_from: data.valid_from ?? data.validFrom ?? null,
      valid_to: data.valid_to ?? data.validTo ?? null,
    };
  }

  async _assertTenantBindings(profileId, brandId, productIds, categoryIds = []) {
    if (profileId == null || profileId === '') return;
    if (!repositoryFactory.isUsingPostgreSQL()) return;

    if (brandId != null && brandId !== '') {
      const r = await query(
        `SELECT 1
         FROM brands b
         WHERE b.id = $1
           AND (
             b.profile_id = $2::bigint
             OR EXISTS (
               SELECT 1 FROM products p
               WHERE p.brand_id = b.id AND p.profile_id = $2::bigint
             )
           )
         LIMIT 1`,
        [brandId, profileId]
      );
      if (!r.rows.length) {
        throw httpError('Бренд не найден в этом аккаунте', 403);
      }
    }

    const pids = normalizeIdList(productIds);
    if (pids.length) {
      const r = await query(
        `SELECT COUNT(*)::int AS n
         FROM products
         WHERE id = ANY($1::bigint[])
           AND profile_id = $2::bigint`,
        [pids, profileId]
      );
      if (Number(r.rows[0]?.n || 0) !== pids.length) {
        throw httpError('Товар не найден в этом аккаунте', 403);
      }
    }

    const cids = normalizeIdList(categoryIds);
    if (cids.length) {
      const r = await query(
        `SELECT COUNT(*)::int AS n
         FROM user_categories
         WHERE id = ANY($1::bigint[]) AND profile_id = $2::bigint`,
        [cids, profileId]
      );
      if (Number(r.rows[0]?.n || 0) !== cids.length) {
        throw httpError('Категория не найдена в этом аккаунте', 403);
      }
    }
  }

  async create(data, options = {}) {
    const profileId = options.profileId ?? options.profile_id ?? null;
    const payload = this._normalizePayload(data);
    await this._assertTenantBindings(
      profileId,
      payload.brand_id,
      payload.product_ids,
      payload.user_category_ids
    );
    const created = await this.repo.create({ ...payload, profile_id: profileId });
    await this._syncMarketplaceFieldsFromCertificate(created, profileId);
    return created;
  }

  async update(id, data, options = {}) {
    const profileId = options.profileId ?? options.profile_id ?? null;
    const existing = await this.repo.findById(id, this._profileOpts(profileId));
    if (!existing) {
      throw httpError('Сертификат не найден', 404);
    }

    const updates = {};
    if (Object.prototype.hasOwnProperty.call(data, 'certificate_number') ||
        Object.prototype.hasOwnProperty.call(data, 'certificateNumber')) {
      const n = String(data.certificate_number ?? data.certificateNumber ?? '').trim();
      if (!n) {
        throw httpError('Номер сертификата обязателен', 400);
      }
      updates.certificate_number = n;
    }
    const map = {
      brand_id: ['brand_id', 'brandId'],
      product_ids: ['product_ids', 'productIds'],
      user_category_id: ['user_category_id', 'userCategoryId'],
      user_category_ids: ['user_category_ids', 'userCategoryIds'],
      document_type: ['document_type', 'documentType'],
      photo_url: ['photo_url', 'photoUrl'],
      valid_from: ['valid_from', 'validFrom'],
      valid_to: ['valid_to', 'validTo'],
    };
    for (const [field, keys] of Object.entries(map)) {
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(data, k)) {
          updates[field] = data[k] === '' ? null : data[k];
          break;
        }
      }
    }

    const touchingBinding =
      Object.prototype.hasOwnProperty.call(updates, 'brand_id') ||
      Object.prototype.hasOwnProperty.call(updates, 'product_ids') ||
      Object.prototype.hasOwnProperty.call(updates, 'user_category_ids') ||
      Object.prototype.hasOwnProperty.call(updates, 'user_category_id');

    let nextBrandId = existing.brand_id ?? null;
    let nextProductIds = normalizeIdList(existing.product_ids);
    let nextCategoryIds = normalizeIdList(existing.user_category_ids);

    if (touchingBinding) {
      if (Object.prototype.hasOwnProperty.call(updates, 'brand_id')) {
        nextBrandId = updates.brand_id;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'product_ids')) {
        nextProductIds = normalizeIdList(updates.product_ids);
        updates.product_ids = nextProductIds;
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'user_category_ids')) {
        nextCategoryIds = normalizeIdList(updates.user_category_ids);
        updates.user_category_ids = nextCategoryIds;
        updates.user_category_id = nextCategoryIds[0] ?? null;
      } else if (Object.prototype.hasOwnProperty.call(updates, 'user_category_id')) {
        nextCategoryIds = normalizeIdList([updates.user_category_id]);
        updates.user_category_ids = nextCategoryIds;
      }

      if (nextBrandId == null || nextBrandId === '') {
        throw httpError('Бренд обязателен', 400);
      }
    }

    await this._assertTenantBindings(profileId, nextBrandId, nextProductIds, nextCategoryIds);

    const updated = await this.repo.update(id, updates, this._profileOpts(profileId));
    if (!updated) {
      throw httpError('Сертификат не найден', 404);
    }
    await this._syncMarketplaceFieldsFromCertificate(updated, profileId);
    return updated;
  }

  async delete(id, options = {}) {
    const profileId = options.profileId ?? options.profile_id ?? null;
    const ok = await this.repo.delete(id, this._profileOpts(profileId));
    if (!ok) {
      throw httpError('Сертификат не найден', 404);
    }
    return true;
  }

  /**
   * Проброс номера/дат в бренд и в wb_attributes привязанных товаров.
   */
  async _syncMarketplaceFieldsFromCertificate(cert, profileId = null) {
    if (!cert) return;
    if (!repositoryFactory.isUsingPostgreSQL()) return;

    const number = cert.certificate_number || null;
    const from = cert.valid_from || null;
    const to = cert.valid_to || null;
    const docType = cert.document_type || 'certificate';
    const pid = cert.profile_id ?? cert.profileId ?? profileId ?? null;

    const fieldsByType = {
      certificate: {
        number: 'certificate_number',
        from: 'certificate_valid_from',
        to: 'certificate_valid_to',
      },
      declaration: {
        number: 'declaration_number',
        from: 'declaration_valid_from',
        to: 'declaration_valid_to',
      },
      registration: {
        number: 'registration_number',
        from: 'registration_valid_from',
        to: 'registration_valid_to',
      },
    };
    const map = fieldsByType[docType] || fieldsByType.certificate;

    try {
      if (cert.brand_id) {
        await query(
          `UPDATE brands SET ${map.number} = $1, ${map.from} = $2, ${map.to} = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4 AND ($5::bigint IS NULL OR profile_id = $5::bigint)`,
          [number, from, to, cert.brand_id, pid]
        );
      }

      const productIds = normalizeIdList(cert.product_ids);
      await this._syncWbCertAttributesToProducts(cert, productIds, pid);
    } catch (e) {
      logger.warn('[Certificates] sync marketplace fields failed:', e?.message || e);
    }
  }

  async _syncWbCertAttributesToProducts(cert, productIds, profileId = null) {
    const ids = normalizeIdList(productIds);
    if (!ids.length) return;

    const patch = wbCertAttributePatch(cert);
    if (!Object.keys(patch).length) return;

    const prodRes = await query(
      `SELECT id, wb_attributes
       FROM products
       WHERE id = ANY($1::bigint[])
         AND ($2::bigint IS NULL OR profile_id = $2::bigint)
         AND wb_attributes IS NOT NULL
         AND jsonb_typeof(wb_attributes) = 'object'`,
      [ids, profileId]
    );

    let updated = 0;
    for (const row of prodRes.rows || []) {
      const { next, changed } = mergeExistingCertKeys(row.wb_attributes, patch);
      if (!changed) continue;
      await query(
        `UPDATE products
         SET wb_attributes = $1::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [JSON.stringify(next), row.id]
      );
      updated += 1;
    }

    if (updated > 0) {
      logger.info('[Certificates] wb_attributes сертификата обновлены в товарах', {
        certificateId: cert?.id,
        linkedProducts: ids.length,
        products: updated,
      });
    }
  }
}

export default new CertificatesService();
