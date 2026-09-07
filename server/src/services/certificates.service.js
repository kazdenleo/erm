/**
 * Certificates Service
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
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

  _normalizePayload(data = {}) {
    const certificate_number = String(data.certificate_number ?? data.certificateNumber ?? '').trim();
    if (!certificate_number) {
      throw httpError('Номер сертификата обязателен', 400);
    }

    const brand_id = data.brand_id ?? data.brandId ?? null;
    if (brand_id == null || brand_id === '') {
      throw httpError('Бренд обязателен', 400);
    }

    const user_category_id = data.user_category_id ?? data.userCategoryId ?? null;
    const user_category_ids = Array.isArray(data.user_category_ids)
      ? data.user_category_ids
      : (Array.isArray(data.userCategoryIds) ? data.userCategoryIds : (user_category_id != null ? [user_category_id] : []));
    const normalizedCategoryIds = user_category_ids
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (normalizedCategoryIds.length === 0) {
      throw httpError('Нужна хотя бы одна категория (бренд и категория указываются только вместе)', 400);
    }

    const document_type = data.document_type ?? data.documentType ?? 'certificate';
    const photo_url = data.photo_url ?? data.photoUrl ?? null;
    const valid_from = data.valid_from ?? data.validFrom ?? null;
    const valid_to = data.valid_to ?? data.validTo ?? null;

    return {
      certificate_number,
      brand_id,
      user_category_id: normalizedCategoryIds[0],
      user_category_ids: normalizedCategoryIds,
      document_type,
      photo_url,
      valid_from,
      valid_to,
    };
  }

  async _assertTenantBindings(profileId, brandId, categoryIds) {
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

    const ids = (Array.isArray(categoryIds) ? categoryIds : [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length) {
      const r = await query(
        `SELECT COUNT(*)::int AS n
         FROM user_categories
         WHERE id = ANY($1::bigint[]) AND profile_id = $2::bigint`,
        [ids, profileId]
      );
      if (Number(r.rows[0]?.n || 0) !== ids.length) {
        throw httpError('Категория не найдена в этом аккаунте', 403);
      }
    }
  }

  async create(data, options = {}) {
    const profileId = options.profileId ?? options.profile_id ?? null;
    const payload = this._normalizePayload(data);
    await this._assertTenantBindings(profileId, payload.brand_id, payload.user_category_ids);
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

    // allow partial update; but if certificate_number provided, validate it
    const updates = {};
    if (data.hasOwnProperty('certificate_number') || data.hasOwnProperty('certificateNumber')) {
      const n = String(data.certificate_number ?? data.certificateNumber ?? '').trim();
      if (!n) {
        throw httpError('Номер сертификата обязателен', 400);
      }
      updates.certificate_number = n;
    }
    const map = {
      brand_id: ['brand_id', 'brandId'],
      user_category_id: ['user_category_id', 'userCategoryId'],
      user_category_ids: ['user_category_ids', 'userCategoryIds'],
      document_type: ['document_type', 'documentType'],
      photo_url: ['photo_url', 'photoUrl'],
      valid_from: ['valid_from', 'validFrom'],
      valid_to: ['valid_to', 'validTo'],
    };
    for (const [field, keys] of Object.entries(map)) {
      for (const k of keys) {
        if (data.hasOwnProperty(k)) {
          updates[field] = data[k] === '' ? null : data[k];
          break;
        }
      }
    }

    // Бренд и категории — только вместе (проверяем при изменении привязки)
    const touchingBinding =
      updates.hasOwnProperty('brand_id') ||
      updates.hasOwnProperty('user_category_id') ||
      updates.hasOwnProperty('user_category_ids');

    let nextBrandId = existing.brand_id ?? null;
    let nextCategoryIds = Array.isArray(existing.user_category_ids)
      ? existing.user_category_ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
      : (existing.user_category_id != null ? [Number(existing.user_category_id)] : []);

    if (touchingBinding) {
      nextBrandId = updates.hasOwnProperty('brand_id')
        ? updates.brand_id
        : (existing.brand_id ?? null);
      if (updates.hasOwnProperty('user_category_ids')) {
        const raw = Array.isArray(updates.user_category_ids) ? updates.user_category_ids : [];
        nextCategoryIds = raw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
        updates.user_category_ids = nextCategoryIds;
        updates.user_category_id = nextCategoryIds[0] ?? null;
      } else if (updates.hasOwnProperty('user_category_id')) {
        nextCategoryIds = updates.user_category_id != null
          ? [Number(updates.user_category_id)].filter((n) => Number.isFinite(n) && n > 0)
          : [];
        updates.user_category_ids = nextCategoryIds;
      }

      if (nextBrandId == null || nextBrandId === '') {
        throw httpError('Бренд обязателен', 400);
      }
      if (!nextCategoryIds.length) {
        throw httpError('Нужна хотя бы одна категория (бренд и категория указываются только вместе)', 400);
      }
    }

    await this._assertTenantBindings(profileId, nextBrandId, nextCategoryIds);

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
   * Проброс номера и дат сертификата в brands/user_categories.
   * Логика: записываем ровно значения из этого сертификата.
   * (Если появятся несколько сертификатов на бренд/категорию — позже можно будет выбрать активный/последний.)
   */
  async _syncMarketplaceFieldsFromCertificate(cert, profileId = null) {
    if (!cert) return;
    if (!repositoryFactory.isUsingPostgreSQL()) return; // for file storage: оставим как есть

    const number = cert.certificate_number || null;
    const from = cert.valid_from || null;
    const to = cert.valid_to || null;
    const docType = cert.document_type || 'certificate';
    const pid = cert.profile_id ?? cert.profileId ?? profileId ?? null;

    // Набор полей для проброса в зависимости от типа документа
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
      // Важно: сертификат может относиться к нескольким категориям (M2M)
      const categoryIds = Array.isArray(cert.user_category_ids)
        ? cert.user_category_ids
        : (cert.user_category_id ? [cert.user_category_id] : []);

      for (const cid of categoryIds) {
        await query(
          `UPDATE user_categories SET ${map.number} = $1, ${map.from} = $2, ${map.to} = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4 AND ($5::bigint IS NULL OR profile_id = $5::bigint)`,
          [number, from, to, cid, pid]
        );
      }
    } catch (_) {
      // не ломаем основной поток
    }
  }
}

export default new CertificatesService();
