/**
 * Отправка локальных сертификатов ERP в «Товары → Документы» Яндекс.Маркета.
 * create (JSON) → bind offerId через offer-mappings/update.certificates.
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';
import { getYandexHttpsAgent, formatYandexNetworkError } from '../utils/yandex-https-agent.js';
import {
  isYmDocumentAlreadyExistsError,
  mapErpDocumentTypeToYm,
  parseYmCreateDocument,
  toYmDateOnly,
  toYmRegistryCertificateNumber,
  ymCreateErrors,
} from '../utils/ymCertificateMap.js';

const BIND_CHUNK = 50;

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function ymFetchJson(url, { method = 'POST', apiKey, body } = {}) {
  const fetch = (await import('node-fetch')).default;
  const agent = getYandexHttpsAgent();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      ...(agent ? { agent } : {}),
      timeout: 60000,
    });
  } catch (e) {
    throw httpError(formatYandexNetworkError(e) || 'Не удалось связаться с API Яндекс.Маркета', 502);
  }
  const text = await response.text().catch(() => '');
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    let msg = `Яндекс.Маркет API ${response.status}`;
    if (data?.errors?.[0]?.message) msg += `: ${data.errors[0].message}`;
    else if (data?.message) msg += `: ${data.message}`;
    else if (text) msg += `: ${text.substring(0, 200)}`;
    // 401/403 от Маркета — это API-ключ интеграции, а не сессия ERP: клиент на 401 разлогинивает пользователя
    const status =
      response.status === 401 || response.status === 403
        ? 400
        : response.status >= 400 && response.status < 500
          ? response.status
          : 502;
    const err = httpError(msg, status);
    err.upstreamStatus = response.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function findYmOfferIdsForCertificate(cert, { profileId, organizationId }) {
  const brandId = cert.brand_id != null ? Number(cert.brand_id) : null;
  const categoryIds = (Array.isArray(cert.user_category_ids) ? cert.user_category_ids : [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!brandId || !categoryIds.length) return [];

  const params = [brandId, categoryIds];
  let sql = `
    SELECT DISTINCT TRIM(ps.sku) AS offer_id
    FROM products p
    INNER JOIN product_skus ps
      ON ps.product_id = p.id
     AND ps.marketplace = 'ym'
     AND ps.sku IS NOT NULL
     AND TRIM(ps.sku) <> ''
    WHERE p.brand_id = $1
      AND p.user_category_id = ANY($2::bigint[])
      AND COALESCE(p.is_archived, false) = false
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
  sql += ` ORDER BY offer_id`;

  try {
    const r = await query(sql, params);
    return (r.rows || [])
      .map((row) => String(row.offer_id || '').trim())
      .filter(Boolean);
  } catch (e) {
    if (/does not exist|column/i.test(String(e?.message || ''))) return [];
    throw e;
  }
}

async function persistYmFields(certId, fields, profileId) {
  if (!repositoryFactory.isUsingPostgreSQL()) return null;
  const allowed = [
    'ym_document_id',
    'ym_status_code',
    'ym_document_type',
    'ym_synced_at',
    'ym_last_error',
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

async function fetchExistingCertificatesMap(businessId, apiKey, offerIds) {
  const out = new Map();
  if (!offerIds.length) return out;
  const url = `https://api.partner.market.yandex.ru/v2/businesses/${encodeURIComponent(String(businessId))}/offer-mappings`;
  try {
    const data = await ymFetchJson(url, {
      apiKey,
      body: { offerIds, limit: Math.min(100, Math.max(offerIds.length, 1)) },
    });
    const mappings =
      data?.result?.offerMappings ||
      data?.offerMappings ||
      data?.result?.offerMappingEntries ||
      [];
    for (const row of Array.isArray(mappings) ? mappings : []) {
      const offerId = String(row?.offer?.offerId || row?.offerId || '').trim();
      if (!offerId) continue;
      const certs = row?.offer?.certificates || row?.certificates || [];
      out.set(
        offerId,
        (Array.isArray(certs) ? certs : [])
          .map((x) => String(x || '').trim())
          .filter(Boolean)
      );
    }
  } catch (_) {
    // без merge всё равно отправим наш номер
  }
  return out;
}

const YM_STATUS_BATCH = 50;

const YM_LIST_MAX_PAGES = 100;

class YmCertificatesPushService {
  /** Удаляет документ в кабинете Маркета (offers/documents/delete). */
  async deleteRemote(ymDocumentId, { profileId = null, organizationId = null } = {}) {
    let ctx;
    try {
      ctx = await integrationsService._resolveYandexBusinessApiContext({ profileId, organizationId });
    } catch (e) {
      throw httpError(e?.message || 'Не настроен Яндекс.Маркет', e?.statusCode || 400);
    }
    const url = `https://api.partner.market.yandex.ru/v1/businesses/${encodeURIComponent(String(ctx.businessId))}/offers/documents/delete`;
    const data = await ymFetchJson(url, { apiKey: ctx.apiKey, body: { documentIds: [Number(ymDocumentId)] } });
    const errs = ymCreateErrors(data);
    if (data?.status && data.status !== 'OK') {
      const msg = errs.map((e) => e?.message || e?.code).filter(Boolean).join('; ');
      throw httpError(`Яндекс.Маркет не удалил документ: ${msg || data.status}`, 400);
    }
    return true;
  }

  /** Все документы кабинета Маркета (offers/documents с page_token). */
  async listAllDocuments({ profileId = null, organizationId = null } = {}) {
    let ctx;
    try {
      ctx = await integrationsService._resolveYandexBusinessApiContext({ profileId, organizationId });
    } catch (e) {
      throw httpError(e?.message || 'Не настроен Яндекс.Маркет', e?.statusCode || 400);
    }
    const base = `https://api.partner.market.yandex.ru/v1/businesses/${encodeURIComponent(String(ctx.businessId))}/offers/documents?limit=${YM_STATUS_BATCH}`;
    const out = [];
    let pageToken = null;
    for (let page = 0; page < YM_LIST_MAX_PAGES; page++) {
      const url = pageToken ? `${base}&page_token=${encodeURIComponent(pageToken)}` : base;
      const data = await ymFetchJson(url, { apiKey: ctx.apiKey, body: {} });
      out.push(...(data?.result?.documents || []));
      pageToken = data?.result?.paging?.nextPageToken || null;
      if (!pageToken) break;
    }
    return out;
  }

  /** Подтягивает status из offers/documents для уже отправленных документов. */
  async syncStatuses(certs, { profileId = null, organizationId = null } = {}) {
    const targets = (certs || []).filter((c) => Number(c.ym_document_id) > 0);
    if (!targets.length) return { checked: 0, updated: 0 };
    let ctx;
    try {
      ctx = await integrationsService._resolveYandexBusinessApiContext({ profileId, organizationId });
    } catch (e) {
      throw httpError(e?.message || 'Не настроен Яндекс.Маркет', e?.statusCode || 400);
    }
    const url = `https://api.partner.market.yandex.ru/v1/businesses/${encodeURIComponent(String(ctx.businessId))}/offers/documents?limit=${YM_STATUS_BATCH}`;
    const byId = new Map();
    for (let offset = 0; offset < targets.length; offset += YM_STATUS_BATCH) {
      const ids = targets.slice(offset, offset + YM_STATUS_BATCH).map((c) => Number(c.ym_document_id));
      const data = await ymFetchJson(url, { apiKey: ctx.apiKey, body: { documentIds: ids } });
      for (const doc of data?.result?.documents || []) byId.set(Number(doc.id), doc);
    }

    let updated = 0;
    for (const cert of targets) {
      const doc = byId.get(Number(cert.ym_document_id));
      if (!doc?.status) continue;
      const statusCode = String(doc.status);
      if (statusCode === cert.ym_status_code) continue;
      await persistYmFields(
        cert.id,
        { ym_status_code: statusCode, ym_synced_at: new Date().toISOString() },
        profileId
      );
      updated++;
    }
    return { checked: targets.length, updated };
  }

  async pushCertificate(certId, options = {}) {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      throw httpError('Отправка сертификатов на Яндекс.Маркет доступна только при работе с PostgreSQL', 501);
    }
    const profileId = options.profileId ?? options.profile_id ?? null;
    const organizationId = options.organizationId ?? options.organization_id ?? null;
    const bindProducts = options.bindProducts !== false;
    const forceCreate = options.forceCreate === true;
    const repo = repositoryFactory.getCertificatesRepository();
    const cert = await repo.findById(certId, profileId != null ? { profileId } : {});
    if (!cert) throw httpError('Сертификат не найден', 404);

    const number = toYmRegistryCertificateNumber(cert.certificate_number);
    if (!number) throw httpError('У сертификата нет номера', 400);
    if (number.length > 100) throw httpError('Номер документа для Яндекс.Маркета не длиннее 100 символов', 400);

    const activeFromDate = toYmDateOnly(cert.valid_from);
    const activeToDate = toYmDateOnly(cert.valid_to);
    const documentType = mapErpDocumentTypeToYm(
      cert.document_type,
      options.documentType ?? options.document_type ?? cert.ym_document_type
    );

    let ctx;
    try {
      ctx = await integrationsService._resolveYandexBusinessApiContext({
        profileId,
        organizationId,
      });
    } catch (e) {
      throw httpError(e?.message || 'Не настроен Яндекс.Маркет', e?.statusCode || 400);
    }

    const baseDocsUrl = `https://api.partner.market.yandex.ru/v1/businesses/${encodeURIComponent(String(ctx.businessId))}/offers/documents`;
    let ymDocumentId =
      !forceCreate && cert.ym_document_id != null ? Number(cert.ym_document_id) : null;
    let statusCode = cert.ym_status_code || null;
    let created = false;

    try {
      if ((!ymDocumentId || !Number.isFinite(ymDocumentId) || ymDocumentId <= 0) && !forceCreate) {
        try {
          const existing = await ymFetchJson(`${baseDocsUrl}?limit=10`, {
            apiKey: ctx.apiKey,
            body: { documentNumbers: [number] },
          });
          const parsed = parseYmCreateDocument(existing, number);
          if (parsed?.id) {
            ymDocumentId = parsed.id;
            statusCode = parsed.status || statusCode;
          } else if (parsed?.number) {
            statusCode = parsed.status || statusCode;
          }
        } catch (_) {
          // создадим ниже
        }
      }

      if (!ymDocumentId || !Number.isFinite(ymDocumentId) || ymDocumentId <= 0 || forceCreate) {
        const docBody = {
          number,
          type: documentType,
        };
        if (activeFromDate) docBody.activeFromDate = activeFromDate;
        if (activeToDate) docBody.activeToDate = activeToDate;

        const createData = await ymFetchJson(`${baseDocsUrl}/create`, {
          apiKey: ctx.apiKey,
          body: { documents: [docBody] },
        });

        const errs = ymCreateErrors(createData);
        const already = errs.find(isYmDocumentAlreadyExistsError);
        if (already && !forceCreate) {
          const existing = await ymFetchJson(`${baseDocsUrl}?limit=10`, {
            apiKey: ctx.apiKey,
            body: { documentNumbers: [number] },
          });
          const parsed = parseYmCreateDocument(existing, number);
          if (parsed?.id) ymDocumentId = parsed.id;
          statusCode = parsed?.status || statusCode || 'ACTIVE';
        } else if (errs.length && !parseYmCreateDocument(createData, number)) {
          const msg = errs
            .map((e) => e?.message || e?.code || String(e))
            .filter(Boolean)
            .join('; ');
          const numberHint = /unsuitable document number/i.test(msg)
            ? ` (отправлен номер «${number}»; Маркет ждёт номер как в реестре ФСА, например «ЕАЭС RU С-CN.НА72.В.00775/24»)`
            : '';
          throw httpError(`Яндекс.Маркет не создал документ: ${msg || 'ошибка API'}${numberHint}`, 400);
        } else {
          const parsed = parseYmCreateDocument(createData, number);
          if (!parsed) {
            throw httpError(
              `Яндекс.Маркет не вернул документ: ${JSON.stringify(createData).slice(0, 300)}`,
              502
            );
          }
          ymDocumentId = parsed.id;
          statusCode = parsed.status || 'VALIDATING';
          created = true;
        }
      }

      let offerIds = [];
      let boundCount = 0;
      const bindErrors = [];
      if (bindProducts) {
        offerIds = await findYmOfferIdsForCertificate(cert, { profileId, organizationId });
        const updateUrl = `https://api.partner.market.yandex.ru/v2/businesses/${encodeURIComponent(String(ctx.businessId))}/offer-mappings/update`;
        for (let offset = 0; offset < offerIds.length; offset += BIND_CHUNK) {
          const chunk = offerIds.slice(offset, offset + BIND_CHUNK);
          const existingMap = await fetchExistingCertificatesMap(ctx.businessId, ctx.apiKey, chunk);
          const offerMappings = chunk.map((offerId) => {
            const prev = existingMap.get(offerId) || [];
            const merged = Array.from(new Set([...prev, number]));
            return { offer: { offerId, certificates: merged } };
          });
          try {
            await ymFetchJson(updateUrl, {
              apiKey: ctx.apiKey,
              body: { offerMappings },
            });
            boundCount += chunk.length;
          } catch (e) {
            bindErrors.push(e?.message || String(e));
          }
        }
      }

      // обновить статус из getDocuments
      try {
        const info = await ymFetchJson(`${baseDocsUrl}?limit=10`, {
          apiKey: ctx.apiKey,
          body: {
            ...(ymDocumentId ? { documentIds: [ymDocumentId] } : {}),
            documentNumbers: [number],
          },
        });
        const parsed = parseYmCreateDocument(info, number);
        if (parsed?.id) ymDocumentId = parsed.id;
        if (parsed?.status) statusCode = parsed.status;
      } catch (_) {}

      const syncedAt = new Date().toISOString();
      const lastError = bindErrors.length
        ? `Привязка частично не удалась: ${bindErrors.slice(0, 3).join('; ')}`
        : null;

      await persistYmFields(
        cert.id,
        {
          ym_document_id: ymDocumentId,
          ym_status_code: statusCode,
          ym_document_type: documentType,
          ym_synced_at: syncedAt,
          ym_last_error: lastError,
        },
        profileId
      );

      const updated = await repo.findById(cert.id, profileId != null ? { profileId } : {});
      return {
        ok: true,
        created,
        ym_document_id: ymDocumentId,
        status_code: statusCode,
        document_type: documentType,
        products_found: offerIds.length,
        products_bound: boundCount,
        bind_errors: bindErrors,
        certificate: updated,
      };
    } catch (e) {
      const msg = e?.message || String(e);
      try {
        await persistYmFields(cert.id, { ym_last_error: msg.slice(0, 2000) }, profileId);
      } catch (_) {}
      if (e?.statusCode) throw e;
      throw httpError(msg, 502);
    }
  }
}

export default new YmCertificatesPushService();
