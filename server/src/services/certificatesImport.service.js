/**
 * Импорт сертификатов, созданных в кабинетах Ozon / Яндекс.Маркета, в реестр ERP.
 * Документы склеиваются по номеру (certificateNumberKey) — между кабинетами и с уже существующими у нас.
 */

import { query, transaction } from '../config/database.js';
import logger from '../utils/logger.js';
import ozonCertificatesPushService from './ozonCertificatesPush.service.js';
import ymCertificatesPushService from './ymCertificatesPush.service.js';
import {
  certificateNumberKey,
  inferBrandAndCategories,
  mergeMarketplaceCertificates,
} from '../utils/certificateImportMap.js';

function errorMessage(e) {
  return e?.message || String(e);
}

class CertificatesImportService {
  async _loadLocal(profileId) {
    const r = await query(
      `SELECT c.id, c.certificate_number, c.brand_id, c.valid_from, c.valid_to,
              c.ozon_certificate_id, c.ym_document_id,
              (SELECT COUNT(*)::int FROM certificate_user_categories cuc WHERE cuc.certificate_id = c.id) AS categories_count
         FROM certificates c
        WHERE c.profile_id = $1::bigint`,
      [profileId]
    );
    return r.rows || [];
  }

  async _inferFromOzonProducts(ozonCertificateId, { profileId, organizationId }) {
    try {
      const productIds = await ozonCertificatesPushService.listCertificateProductIds(ozonCertificateId, {
        profileId,
        organizationId,
      });
      if (!productIds.length) return { brandId: null, categoryIds: [] };
      const r = await query(
        `SELECT p.brand_id, p.user_category_id
           FROM product_skus ps
           JOIN products p ON p.id = ps.product_id
          WHERE ps.marketplace = 'ozon'
            AND ps.marketplace_product_id::text = ANY($1::text[])
            AND p.profile_id = $2::bigint
            AND p.user_category_id IN (SELECT id FROM user_categories WHERE profile_id = $2::bigint)`,
        [productIds.map(String), profileId]
      );
      const inferred = inferBrandAndCategories(r.rows || []);
      // бренд и категории в реестре указываются только вместе
      return inferred.brandId && inferred.categoryIds.length ? inferred : { brandId: null, categoryIds: [] };
    } catch (e) {
      logger.warn('[Certificates import] brand inference failed', { ozonCertificateId, message: errorMessage(e) });
      return { brandId: null, categoryIds: [] };
    }
  }

  _marketplaceFields(entry) {
    const fields = {};
    if (entry.ozon) {
      fields.ozon_certificate_id = Number(entry.ozon.certificate_id) || null;
      fields.ozon_status_code = entry.ozon.status_code || null;
      fields.ozon_name = entry.ozon.certificate_name ? String(entry.ozon.certificate_name).slice(0, 255) : null;
      fields.ozon_synced_at = new Date().toISOString();
    }
    if (entry.ym) {
      fields.ym_document_id = Number(entry.ym.id) || null;
      fields.ym_status_code = entry.ym.status || null;
      fields.ym_document_type = entry.ym.type || null;
      fields.ym_synced_at = new Date().toISOString();
    }
    return fields;
  }

  async _createLocal(entry, binding, profileId) {
    const fields = {
      certificate_number: entry.number,
      document_type: entry.documentType || 'certificate',
      valid_from: entry.validFrom,
      valid_to: entry.validTo,
      brand_id: binding.brandId,
      user_category_id: binding.categoryIds[0] || null,
      profile_id: profileId,
      ...this._marketplaceFields(entry),
    };
    const cols = Object.keys(fields);
    return transaction(async (client) => {
      const r = await client.query(
        `INSERT INTO certificates (${cols.join(', ')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING id`,
        cols.map((c) => fields[c])
      );
      const id = r.rows[0].id;
      for (const cid of binding.categoryIds) {
        await client.query(
          `INSERT INTO certificate_user_categories (certificate_id, user_category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, cid]
        );
      }
      return id;
    });
  }

  async _linkLocal(local, entry, binding, profileId) {
    const mp = this._marketplaceFields(entry);
    const fields = {};
    if (entry.ozon && local.ozon_certificate_id == null) {
      for (const k of ['ozon_certificate_id', 'ozon_status_code', 'ozon_name', 'ozon_synced_at']) {
        fields[k] = mp[k];
      }
    }
    if (entry.ym && local.ym_document_id == null) {
      for (const k of ['ym_document_id', 'ym_status_code', 'ym_document_type', 'ym_synced_at']) fields[k] = mp[k];
    }
    if (!Object.keys(fields).length) return false;
    if (local.valid_from == null && entry.validFrom) fields.valid_from = entry.validFrom;
    if (local.valid_to == null && entry.validTo) fields.valid_to = entry.validTo;
    const fillBinding = local.brand_id == null && !local.categories_count && Boolean(binding.brandId);
    if (fillBinding) {
      fields.brand_id = binding.brandId;
      fields.user_category_id = binding.categoryIds[0];
    }

    const cols = Object.keys(fields);
    await transaction(async (client) => {
      await client.query(
        `UPDATE certificates SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $${cols.length + 1} AND profile_id = $${cols.length + 2}::bigint`,
        [...cols.map((c) => fields[c]), local.id, profileId]
      );
      if (fillBinding) {
        for (const cid of binding.categoryIds) {
          await client.query(
            `INSERT INTO certificate_user_categories (certificate_id, user_category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [local.id, cid]
          );
        }
      }
    });
    return true;
  }

  async importFromMarketplaces({ profileId, organizationId = null }) {
    const opts = { profileId, organizationId };
    const errors = {};
    const [ozonRows, ymDocs] = await Promise.all([
      ozonCertificatesPushService.listAllCertificates(opts).catch((e) => {
        errors.ozon = errorMessage(e);
        return [];
      }),
      ymCertificatesPushService.listAllDocuments(opts).catch((e) => {
        errors.ym = errorMessage(e);
        return [];
      }),
    ]);

    const entries = mergeMarketplaceCertificates(ozonRows, ymDocs);
    const locals = await this._loadLocal(profileId);
    const byOzonId = new Map(locals.filter((l) => l.ozon_certificate_id != null).map((l) => [Number(l.ozon_certificate_id), l]));
    const byYmId = new Map(locals.filter((l) => l.ym_document_id != null).map((l) => [Number(l.ym_document_id), l]));
    const byKey = new Map();
    for (const l of locals) {
      const key = certificateNumberKey(l.certificate_number);
      if (key && !byKey.has(key)) byKey.set(key, l);
    }

    const result = { created: 0, linked: 0, unchanged: 0, without_brand: 0, errors };
    for (const entry of entries) {
      try {
        const local =
          (entry.ozon && byOzonId.get(Number(entry.ozon.certificate_id))) ||
          (entry.ym && byYmId.get(Number(entry.ym.id))) ||
          byKey.get(entry.key) ||
          null;
        const needsBinding = !local || (local.brand_id == null && !local.categories_count);
        const binding =
          needsBinding && entry.ozon
            ? await this._inferFromOzonProducts(entry.ozon.certificate_id, opts)
            : { brandId: null, categoryIds: [] };

        if (!local) {
          const id = await this._createLocal(entry, binding, profileId);
          result.created++;
          if (!binding.brandId) result.without_brand++;
          const created = { id, certificate_number: entry.number, ozon_certificate_id: entry.ozon?.certificate_id ?? null, ym_document_id: entry.ym?.id ?? null };
          byKey.set(entry.key, created);
        } else if (await this._linkLocal(local, entry, binding, profileId)) {
          result.linked++;
        } else {
          result.unchanged++;
        }
      } catch (e) {
        logger.warn('[Certificates import] entry failed', { number: entry.number, message: errorMessage(e) });
        result.errors.items = [...(result.errors.items || []), `${entry.number}: ${errorMessage(e)}`].slice(0, 10);
      }
    }
    return result;
  }
}

export default new CertificatesImportService();
