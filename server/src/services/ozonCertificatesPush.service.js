/**
 * Отправка локальных сертификатов ERP в раздел «Сертификаты» Ozon Seller.
 * v2 create (JSON, файл base64) → bind product_id → сохранение ozon_certificate_id.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { ozonApiPostWithRetry } from '../utils/ozonSellerApi.js';
import {
  buildOzonCertificateName,
  buildOzonV2CertificateParams,
  describeOzonV2CreateErrors,
  guessAccordanceTypeCode,
  isOzonCertificateFileAllowed,
  mapErpDocumentTypeToOzon,
  needsAccordanceType,
  normalizeOzonCertificateNumber,
  parseOzonCertificateCreateId,
  toOzonDateTime,
} from '../utils/ozonCertificateMap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const BIND_CHUNK = 100;

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function resolveLocalFilePath(photoUrl) {
  if (!photoUrl) return null;
  const rel = String(photoUrl).replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return null;
  return path.resolve(ROOT_DIR, rel);
}

async function findOzonProductIdsForCertificate(cert, { profileId, organizationId }) {
  const brandId = cert.brand_id != null ? Number(cert.brand_id) : null;
  const categoryIds = (Array.isArray(cert.user_category_ids) ? cert.user_category_ids : [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!brandId || !categoryIds.length) return [];

  const params = [brandId, categoryIds];
  let sql = `
    SELECT DISTINCT ps.marketplace_product_id::bigint AS ozon_product_id
    FROM products p
    INNER JOIN product_skus ps
      ON ps.product_id = p.id
     AND ps.marketplace = 'ozon'
     AND ps.marketplace_product_id IS NOT NULL
    WHERE p.brand_id = $1
      AND p.user_category_id = ANY($2::bigint[])
      AND COALESCE(p.is_archived, false) = false
      AND ps.marketplace_product_id::text ~ '^[0-9]+$'
  `;
  let i = 3;
  if (profileId != null && profileId !== '') {
    sql += ` AND p.profile_id = $${i++}::bigint`;
    params.push(profileId);
  }
  if (organizationId != null && organizationId !== '') {
    sql += ` AND (p.organization_id = $${i++}::bigint OR p.organization_id IS NULL)`;
    params.push(organizationId);
  }
  sql += ` ORDER BY ozon_product_id`;

  try {
    const r = await query(sql, params);
    return (r.rows || [])
      .map((row) => Number(row.ozon_product_id))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) {
    // product_skus / is_archived могут отсутствовать на старых схемах
    if (/does not exist|column/i.test(String(e?.message || ''))) {
      return [];
    }
    throw e;
  }
}

async function persistOzonFields(certId, fields, profileId) {
  if (!repositoryFactory.isUsingPostgreSQL()) return null;
  const allowed = [
    'ozon_certificate_id',
    'ozon_status_code',
    'ozon_name',
    'ozon_accordance_type_code',
    'ozon_synced_at',
    'ozon_last_error',
  ];
  const sets = [];
  const params = [];
  let i = 1;
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    sets.push(`${key} = $${i++}`);
    params.push(fields[key]);
  }
  if (!sets.length) return null;
  params.push(certId);
  let sql = `UPDATE certificates SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${i++}`;
  if (profileId != null && profileId !== '') {
    sql += ` AND profile_id = $${i}::bigint`;
    params.push(profileId);
  }
  sql += ' RETURNING *';
  const r = await query(sql, params);
  return r.rows[0] || null;
}

const OZON_LIST_PAGE_SIZE = 100;
const OZON_LIST_MAX_PAGES = 50;

const OZON_CERT_PRODUCTS_LIMIT = 1000;

class OzonCertificatesPushService {
  /** Все сертификаты кабинета Ozon (/v1/product/certificate/list). */
  async listAllCertificates({ profileId = null, organizationId = null } = {}) {
    const ozonApiOpts = { profileId, organizationId };
    const out = [];
    for (let page = 1; page <= OZON_LIST_MAX_PAGES; page++) {
      const data = await ozonApiPostWithRetry(
        '/v1/product/certificate/list',
        { page, page_size: OZON_LIST_PAGE_SIZE },
        ozonApiOpts
      );
      const rows = data?.result?.certificates || [];
      out.push(...rows);
      const pageCount = Number(data?.result?.page_count);
      if (rows.length < OZON_LIST_PAGE_SIZE || (Number.isFinite(pageCount) && page >= pageCount)) break;
    }
    return out;
  }

  /** product_id товаров Ozon, привязанных к сертификату (первые 1000 — для определения бренда хватает). */
  async listCertificateProductIds(ozonCertificateId, { profileId = null, organizationId = null } = {}) {
    const data = await ozonApiPostWithRetry(
      '/v1/product/certificate/products/list',
      { certificate_id: Number(ozonCertificateId), limit: OZON_CERT_PRODUCTS_LIMIT },
      { profileId, organizationId }
    );
    return (data?.result?.items || [])
      .map((it) => Number(it?.product_id))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  /** Подтягивает status_code из /v1/product/certificate/list для уже отправленных сертификатов. */
  async syncStatuses(certs, { profileId = null, organizationId = null } = {}) {
    const targets = (certs || []).filter((c) => Number(c.ozon_certificate_id) > 0);
    if (!targets.length) return { checked: 0, updated: 0 };
    const byId = new Map();
    for (const row of await this.listAllCertificates({ profileId, organizationId })) {
      byId.set(Number(row.certificate_id), row);
    }

    let updated = 0;
    for (const cert of targets) {
      const row = byId.get(Number(cert.ozon_certificate_id));
      if (!row?.status_code) continue;
      const statusCode = String(row.status_code);
      const fields = { ozon_status_code: statusCode, ozon_synced_at: new Date().toISOString() };
      if (statusCode === 'declined') {
        const reason = String(row.verification_comment || row.rejection_reason_code || '').trim();
        fields.ozon_last_error = reason ? `Отклонён Ozon: ${reason}`.slice(0, 2000) : 'Отклонён Ozon';
      } else if (String(cert.ozon_last_error || '').startsWith('Отклонён Ozon')) {
        fields.ozon_last_error = null;
      }
      if (statusCode !== cert.ozon_status_code || fields.ozon_last_error !== undefined) {
        await persistOzonFields(cert.id, fields, profileId);
        updated++;
      }
    }
    return { checked: targets.length, updated };
  }

  async pushCertificate(certId, options = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      throw httpError('Отправка сертификатов на Ozon доступна только при работе с PostgreSQL', 501);
    }
    const profileId = options.profileId ?? options.profile_id ?? null;
    const organizationId = options.organizationId ?? options.organization_id ?? null;
    const bindProducts = options.bindProducts !== false;
    const forceCreate = options.forceCreate === true;
    const repo = repositoryFactory.getCertificatesRepository();
    const cert = await repo.findById(certId, profileId != null ? { profileId } : {});
    if (!cert) throw httpError('Сертификат не найден', 404);

    const number = String(cert.certificate_number || '').trim();
    if (!number) throw httpError('У сертификата нет номера', 400);
    const ozonNumber = normalizeOzonCertificateNumber(number);

    const issueDate = toOzonDateTime(cert.valid_from);
    if (!issueDate) {
      throw httpError('Укажите дату начала действия сертификата перед отправкой на Ozon', 400);
    }
    const expireDate = toOzonDateTime(cert.valid_to);

    const typeCode = mapErpDocumentTypeToOzon(cert.document_type);
    const accordanceTypeCode = guessAccordanceTypeCode(
      number,
      options.accordanceTypeCode ?? options.accordance_type_code ?? cert.ozon_accordance_type_code
    );
    if (needsAccordanceType(typeCode) && !accordanceTypeCode) {
      throw httpError('Укажите тип соответствия требованиям (ТР ТС / ТР РФ / ГОСТ)', 400);
    }

    const name = String(options.name || cert.ozon_name || buildOzonCertificateName(cert)).trim().slice(0, 100);
    if (!name) throw httpError('Укажите название сертификата для Ozon', 400);

    const ozonApiOpts = { profileId, organizationId };
    let ozonCertificateId =
      !forceCreate && cert.ozon_certificate_id != null ? Number(cert.ozon_certificate_id) : null;
    let created = false;

    try {
      if ((!ozonCertificateId || !Number.isFinite(ozonCertificateId) || ozonCertificateId <= 0) && !forceCreate) {
        try {
          const existing = await ozonApiPostWithRetry(
            '/v1/product/certificate/info',
            { certificate_number: ozonNumber },
            ozonApiOpts
          );
          const existingId = Number(existing?.result?.certificate_id ?? existing?.certificate_id);
          if (Number.isFinite(existingId) && existingId > 0) {
            ozonCertificateId = existingId;
          }
        } catch (_) {
          // нет на Ozon — создадим ниже
        }
      }

      if (!ozonCertificateId || !Number.isFinite(ozonCertificateId) || ozonCertificateId <= 0) {
        const files = [];
        const filePath = resolveLocalFilePath(cert.photo_url || cert.photoUrl);
        if (filePath && fs.existsSync(filePath)) {
          const filename = path.basename(filePath);
          if (!isOzonCertificateFileAllowed(filename)) {
            throw httpError('Ozon принимает только jpg, jpeg, png или pdf. Пересохраните файл в одном из этих форматов.', 400);
          }
          files.push({ name: filename, file_content: fs.readFileSync(filePath).toString('base64') });
        }

        const createParams = buildOzonV2CertificateParams({
          typeCode,
          number,
          name,
          accordanceTypeCode,
          issueDate,
          expireDate,
          files,
        });
        const createData = await ozonApiPostWithRetry(
          '/v2/product/certificate/create',
          { params: createParams },
          ozonApiOpts
        );
        ozonCertificateId = parseOzonCertificateCreateId(createData);
        if (!ozonCertificateId) {
          const problems = describeOzonV2CreateErrors(createData);
          if (problems.length) {
            const needsFile = !files.length && problems.some((p) => p.startsWith('Файл'));
            throw httpError(
              `Ozon не принял сертификат: ${problems.join('; ')}${
                needsFile ? '. Загрузите файл сертификата (jpg/png/pdf) в карточке документа.' : ''
              }`,
              400
            );
          }
          throw httpError(
            `Ozon не вернул ID сертификата: ${JSON.stringify(createData).slice(0, 300)}`,
            502
          );
        }
        created = true;
      }

      let productIds = [];
      let boundCount = 0;
      const bindErrors = [];
      if (bindProducts) {
        productIds = await findOzonProductIdsForCertificate(cert, { profileId, organizationId });
        for (let offset = 0; offset < productIds.length; offset += BIND_CHUNK) {
          const chunk = productIds.slice(offset, offset + BIND_CHUNK);
          try {
            await ozonApiPostWithRetry(
              '/v1/product/certificate/bind',
              { certificate_id: ozonCertificateId, product_id: chunk },
              ozonApiOpts
            );
            boundCount += chunk.length;
          } catch (e) {
            bindErrors.push(e?.message || String(e));
          }
        }
      }

      let statusCode = cert.ozon_status_code || (created ? 'pending' : null);
      try {
        const info = await ozonApiPostWithRetry(
          '/v1/product/certificate/info',
          { certificate_number: ozonNumber },
          ozonApiOpts
        );
        const st = info?.result?.status_code ?? info?.status_code;
        if (st) statusCode = String(st);
        const infoId = Number(info?.result?.certificate_id ?? info?.certificate_id);
        if (Number.isFinite(infoId) && infoId > 0) {
          ozonCertificateId = infoId;
        }
      } catch (_) {
        // info не критичен — статус обновим при следующей синхронизации
      }

      const syncedAt = new Date().toISOString();
      const lastError = bindErrors.length
        ? `Привязка частично не удалась: ${bindErrors.slice(0, 3).join('; ')}`
        : null;

      await persistOzonFields(
        cert.id,
        {
          ozon_certificate_id: ozonCertificateId,
          ozon_status_code: statusCode,
          ozon_name: name,
          ozon_accordance_type_code: accordanceTypeCode,
          ozon_synced_at: syncedAt,
          ozon_last_error: lastError,
        },
        profileId
      );

      const updated = await repo.findById(cert.id, profileId != null ? { profileId } : {});
      return {
        ok: true,
        created,
        ozon_certificate_id: ozonCertificateId,
        status_code: statusCode,
        name,
        accordance_type_code: accordanceTypeCode,
        products_found: productIds.length,
        products_bound: boundCount,
        bind_errors: bindErrors,
        certificate: updated,
      };
    } catch (e) {
      const msg = e?.message || String(e);
      try {
        await persistOzonFields(cert.id, { ozon_last_error: msg.slice(0, 2000) }, profileId);
      } catch (_) {}
      if (e?.statusCode) throw e;
      const status = /Client ID|API Key/i.test(msg) ? 400 : 502;
      throw httpError(msg, status);
    }
  }
}

export default new OzonCertificatesPushService();
