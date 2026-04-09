/**
 * Certificates Service
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';

class CertificatesService {
  constructor() {
    this.repo = repositoryFactory.getCertificatesRepository();
  }

  async getAll(options = {}) {
    return await this.repo.findAll(options);
  }

  async getById(id) {
    const item = await this.repo.findById(id);
    if (!item) {
      const err = new Error('Сертификат не найден');
      err.statusCode = 404;
      throw err;
    }
    return item;
  }

  _normalizePayload(data = {}) {
    const certificate_number = String(data.certificate_number ?? data.certificateNumber ?? '').trim();
    if (!certificate_number) {
      const err = new Error('Номер сертификата обязателен');
      err.statusCode = 400;
      throw err;
    }

    const brand_id = data.brand_id ?? data.brandId ?? null;
    const user_category_id = data.user_category_id ?? data.userCategoryId ?? null;
    const user_category_ids = Array.isArray(data.user_category_ids)
      ? data.user_category_ids
      : (Array.isArray(data.userCategoryIds) ? data.userCategoryIds : (user_category_id != null ? [user_category_id] : []));
    const document_type = data.document_type ?? data.documentType ?? 'certificate';
    const photo_url = data.photo_url ?? data.photoUrl ?? null;
    const valid_from = data.valid_from ?? data.validFrom ?? null;
    const valid_to = data.valid_to ?? data.validTo ?? null;

    return { certificate_number, brand_id, user_category_id, user_category_ids, document_type, photo_url, valid_from, valid_to };
  }

  async create(data) {
    const payload = this._normalizePayload(data);
    const created = await this.repo.create(payload);
    await this._syncMarketplaceFieldsFromCertificate(created);
    return created;
  }

  async update(id, data) {
    const existing = await this.repo.findById(id);
    if (!existing) {
      const err = new Error('Сертификат не найден');
      err.statusCode = 404;
      throw err;
    }

    // allow partial update; but if certificate_number provided, validate it
    const updates = {};
    if (data.hasOwnProperty('certificate_number') || data.hasOwnProperty('certificateNumber')) {
      const n = String(data.certificate_number ?? data.certificateNumber ?? '').trim();
      if (!n) {
        const err = new Error('Номер сертификата обязателен');
        err.statusCode = 400;
        throw err;
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

    const updated = await this.repo.update(id, updates);
    await this._syncMarketplaceFieldsFromCertificate(updated);
    return updated;
  }

  async delete(id) {
    const ok = await this.repo.delete(id);
    if (!ok) {
      const err = new Error('Сертификат не найден');
      err.statusCode = 404;
      throw err;
    }
    return true;
  }

  /**
   * Проброс номера и дат сертификата в brands/user_categories.
   * Логика: записываем ровно значения из этого сертификата.
   * (Если появятся несколько сертификатов на бренд/категорию — позже можно будет выбрать активный/последний.)
   */
  async _syncMarketplaceFieldsFromCertificate(cert) {
    if (!cert) return;
    if (!repositoryFactory.isUsingPostgreSQL()) return; // for file storage: оставим как есть

    const number = cert.certificate_number || null;
    const from = cert.valid_from || null;
    const to = cert.valid_to || null;
    const docType = cert.document_type || 'certificate';

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
          `UPDATE brands SET ${map.number} = $1, ${map.from} = $2, ${map.to} = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
          [number, from, to, cert.brand_id]
        );
      }
      // Важно: сертификат может относиться к нескольким категориям (M2M)
      const categoryIds = Array.isArray(cert.user_category_ids)
        ? cert.user_category_ids
        : (cert.user_category_id ? [cert.user_category_id] : []);

      for (const cid of categoryIds) {
        await query(
          `UPDATE user_categories SET ${map.number} = $1, ${map.from} = $2, ${map.to} = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
          [number, from, to, cid]
        );
      }
    } catch (_) {
      // не ломаем основной поток
    }
  }
}

export default new CertificatesService();

