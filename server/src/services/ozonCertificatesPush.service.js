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
import { summarizeOzonBinding } from '../utils/certificateBindingReport.js';

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

/** Товары ERP бренда и категорий сертификата, у которых есть product_id Ozon. */
async function findOzonProductsForCertificate(cert, { profileId, organizationId }) {
  const brandId = cert.brand_id != null ? Number(cert.brand_id) : null;
  const categoryIds = (Array.isArray(cert.user_category_ids) ? cert.user_category_ids : [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!brandId || !categoryIds.length) return [];

  const params = [brandId, categoryIds];
  let sql = `
    SELECT DISTINCT ON (ps.marketplace_product_id::bigint)
      ps.marketplace_product_id::bigint AS ozon_product_id, p.id AS product_id, p.sku
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
  sql += ` ORDER BY ps.marketplace_product_id::bigint, p.id`;

  try {
    const r = await query(sql, params);
    return (r.rows || [])
      .map((row) => ({
        productId: Number(row.product_id),
        sku: row.sku || null,
        ozonProductId: Number(row.ozon_product_id),
      }))
      .filter((it) => Number.isFinite(it.ozonProductId) && it.ozonProductId > 0);
  } catch (e) {
    // product_skus / is_archived могут отсутствовать на старых схемах
    if (/does not exist|column/i.test(String(e?.message || ''))) {
      return [];
    }
    throw e;
  }
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function bindingErrorText(report) {
  if (!report) return null;
  const parts = [];
  if (report.missing_count > 0) {
    const held = report.held_by_other_count
      ? ` (${report.held_by_other_count} — привязаны к другому сертификату)`
      : '';
    parts.push(`Не привязано на Ozon: ${report.missing_count} из ${report.expected}${held}`);
  }
  const declined = report.statuses?.declined || 0;
  if (declined > 0) parts.push(`Ozon отклонил привязку ${declined} товаров`);
  return parts.length ? parts.join('. ') : null;
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
const OZON_HOLDER_SCAN_LIMIT = 80;

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

  /** Все товары сертификата на Ozon со статусом проверки: [{ product_id, product_status_code, sku }]. */
  async listCertificateProducts(ozonCertificateId, { profileId = null, organizationId = null } = {}) {
    const opts = { profileId, organizationId };
    const id = Number(ozonCertificateId);
    const out = [];
    let lastId = null;
    for (let page = 1; page <= OZON_LIST_MAX_PAGES; page++) {
      const body = { certificate_id: id, limit: OZON_CERT_PRODUCTS_LIMIT };
      if (lastId != null) body.last_id = String(lastId);
      const data = await ozonApiPostWithRetry('/v1/product/certificate/products/list', body, opts);
      const items = data?.result?.items || [];
      out.push(...items);
      const total = Number(data?.result?.count);
      const nextId = items.at(-1)?.product_id;
      if (
        items.length < OZON_CERT_PRODUCTS_LIMIT ||
        (Number.isFinite(total) && out.length >= total) ||
        nextId == null ||
        String(nextId) === String(lastId)
      ) break;
      lastId = nextId;
    }
    return out;
  }

  /**
   * К каким сертификатам кабинета Ozon привязаны товары: Map(product_id → { certificateId, number }).
   * Ozon держит товар только в одном сертификате и молча не привязывает его к новому.
   */
  async findCertificateHolders(ozonProductIds, { excludeCertificateId = null, profileId = null, organizationId = null } = {}) {
    const wanted = new Set((ozonProductIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
    const out = new Map();
    if (!wanted.size) return out;
    const certs = await this.listAllCertificates({ profileId, organizationId });
    const candidates = certs
      .filter((c) => Number(c.certificate_id) !== Number(excludeCertificateId))
      .filter((c) => c.products_count == null || Number(c.products_count) > 0)
      .slice(0, OZON_HOLDER_SCAN_LIMIT);
    for (const c of candidates) {
      const items = await this.listCertificateProducts(c.certificate_id, { profileId, organizationId });
      for (const it of items) {
        const pid = Number(it?.product_id);
        if (!wanted.has(pid) || out.has(pid)) continue;
        out.set(pid, { certificateId: Number(c.certificate_id), number: c.certificate_number || null });
      }
      if (out.size >= wanted.size) break;
    }
    return out;
  }

  /** Отвязывает товары от сертификата Ozon; возвращает тексты ошибок по товарам. */
  async unbindProducts(ozonCertificateId, productIds, { profileId = null, organizationId = null } = {}) {
    const errors = [];
    for (const chunk of chunks(productIds, BIND_CHUNK)) {
      const data = await ozonApiPostWithRetry(
        '/v1/product/certificate/unbind',
        { certificate_id: Number(ozonCertificateId), product_id: chunk },
        { profileId, organizationId }
      );
      for (const r of Array.isArray(data?.result) ? data.result : []) {
        if (r?.error) errors.push(`${r.product_id}: ${r.error}`);
      }
    }
    return errors;
  }

  async _buildBindingReport(cert, ozonCertificateId, expected, { profileId, organizationId }) {
    const opts = { profileId, organizationId };
    const bound = await this.listCertificateProducts(ozonCertificateId, opts);
    const boundIds = new Set(bound.map((it) => Number(it.product_id)));
    const missingIds = expected.map((it) => it.ozonProductId).filter((id) => !boundIds.has(id));
    const heldBy = missingIds.length
      ? await this.findCertificateHolders(missingIds, { ...opts, excludeCertificateId: ozonCertificateId })
      : new Map();
    return { report: summarizeOzonBinding({ expected, bound, heldBy }), heldBy };
  }

  /** Сверка: какие товары ERP привязаны к сертификату на Ozon и почему остальные — нет. */
  async bindingReport(certId, { profileId = null, organizationId = null } = {}) {
    const repo = repositoryFactory.getCertificatesRepository();
    const cert = await repo.findById(certId, profileId != null ? { profileId } : {});
    if (!cert) throw httpError('Сертификат не найден', 404);
    const ozonCertificateId = Number(cert.ozon_certificate_id);
    if (!Number.isFinite(ozonCertificateId) || ozonCertificateId <= 0) return null;
    const expected = await findOzonProductsForCertificate(cert, { profileId, organizationId });
    const { report } = await this._buildBindingReport(cert, ozonCertificateId, expected, {
      profileId,
      organizationId,
    });
    return report;
  }

  /** Удаляет сертификат в кабинете Ozon; Ozon отвечает 200 с is_delete=false, если удалить нельзя. */
  async deleteRemote(ozonCertificateId, { profileId = null, organizationId = null } = {}) {
    const data = await ozonApiPostWithRetry(
      '/v1/product/certificate/delete',
      { certificate_id: Number(ozonCertificateId) },
      { profileId, organizationId }
    );
    if (data?.result?.is_delete !== true) {
      throw httpError(`Ozon не удалил сертификат: ${data?.result?.error_message || 'причина не указана'}`, 400);
    }
    return true;
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
    const rebindFromOther = bindProducts && options.rebindFromOther === true;
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

      let expected = [];
      const bindErrors = [];
      let rebound = 0;
      let bindingReport = null;
      const bindChunks = async (ids) => {
        for (const chunk of chunks(ids, BIND_CHUNK)) {
          try {
            await ozonApiPostWithRetry(
              '/v1/product/certificate/bind',
              { certificate_id: ozonCertificateId, product_id: chunk },
              ozonApiOpts
            );
          } catch (e) {
            bindErrors.push(e?.message || String(e));
          }
        }
      };
      if (bindProducts) {
        expected = await findOzonProductsForCertificate(cert, { profileId, organizationId });
        await bindChunks(expected.map((it) => it.ozonProductId));
        try {
          const first = await this._buildBindingReport(cert, ozonCertificateId, expected, ozonApiOpts);
          bindingReport = first.report;
          if (rebindFromOther && first.heldBy.size > 0) {
            const byHolder = new Map();
            for (const [pid, holder] of first.heldBy) {
              const list = byHolder.get(holder.certificateId) || [];
              list.push(pid);
              byHolder.set(holder.certificateId, list);
            }
            const moved = [];
            for (const [holderId, ids] of byHolder) {
              try {
                const errs = await this.unbindProducts(holderId, ids, ozonApiOpts);
                if (errs.length) bindErrors.push(`Отвязка от ${holderId}: ${errs.slice(0, 3).join('; ')}`);
                moved.push(...ids);
              } catch (e) {
                bindErrors.push(`Отвязка от ${holderId}: ${e?.message || String(e)}`);
              }
            }
            if (moved.length) {
              await bindChunks(moved);
              rebound = moved.length;
              bindingReport = (await this._buildBindingReport(cert, ozonCertificateId, expected, ozonApiOpts))
                .report;
            }
          }
        } catch (e) {
          bindErrors.push(`Проверка привязки: ${e?.message || String(e)}`);
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
      const lastError =
        [
          bindErrors.length ? `Привязка частично не удалась: ${bindErrors.slice(0, 3).join('; ')}` : null,
          bindingErrorText(bindingReport),
        ]
          .filter(Boolean)
          .join('. ') || null;

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
        products_found: expected.length,
        products_bound: bindingReport ? bindingReport.bound : 0,
        products_rebound: rebound,
        bind_errors: bindErrors,
        binding_report: bindingReport,
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
