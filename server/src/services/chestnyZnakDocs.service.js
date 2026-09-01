/**
 * Реестр КИ и документы Честного знака — всегда в разрезе организации.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import {
  buildLkReceiptPayload,
  encodeProductDocument,
  extractGtinFromCis,
  normalizeCis,
  normalizeOperations,
  operationById,
  splitCisList,
} from '../utils/chestnyZnak.js';
import chestnyZnakService from './chestnyZnak.service.js';

function httpError(message, statusCode = 400, details = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (details != null) err.details = details;
  return err;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function nextCisStatus(kind, docStatus) {
  if (docStatus === 'rejected') return null;
  if (kind === 'purchase_accept' && (docStatus === 'edo_done' || docStatus === 'accepted' || docStatus === 'sent')) {
    return 'in_stock';
  }
  if ((kind === 'wholesale_ship' || kind === 'fbo_transfer')
    && (docStatus === 'edo_done' || docStatus === 'accepted' || docStatus === 'sent')) {
    return 'transferred';
  }
  if ((kind === 'fbs_distance' || kind === 'own_use' || kind === 'retail')
    && (docStatus === 'sent' || docStatus === 'accepted')) {
    return 'withdrawn';
  }
  if (docStatus === 'draft' || docStatus === 'ready' || docStatus === 'edo_pending') {
    return 'reserved';
  }
  return null;
}

class ChestnyZnakDocsService {
  _scope(ctx) {
    chestnyZnakService._requirePg();
    chestnyZnakService._requireScope(ctx);
  }

  async _assertOperationEnabled(kind, ctx) {
    const cfg = await chestnyZnakService._loadConfig(ctx);
    const ops = normalizeOperations(cfg.operations);
    if (ops[kind] === false) {
      throw httpError(`Схема «${operationById(kind)?.name || kind}» выключена для этой организации`);
    }
    return cfg;
  }

  async listCis({ status, sourceType, sourceId, q, limit = 200 } = {}, ctx) {
    this._scope(ctx);
    const { profileId, organizationId } = ctx;
    const params = [profileId, organizationId];
    const where = ['profile_id = $1', 'organization_id = $2'];
    if (status) {
      params.push(String(status));
      where.push(`status = $${params.length}`);
    }
    if (sourceType) {
      params.push(String(sourceType));
      where.push(`source_type = $${params.length}`);
    }
    if (sourceId != null && sourceId !== '') {
      params.push(Number(sourceId));
      where.push(`source_id = $${params.length}`);
    }
    if (q) {
      params.push(`%${String(q).trim()}%`);
      where.push(`(cis ILIKE $${params.length} OR COALESCE(gtin, '') ILIKE $${params.length})`);
    }
    const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
    params.push(cap);
    const result = await query(
      `SELECT * FROM chestny_znak_cis
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC
       LIMIT $${params.length}`,
      params
    );
    return { items: result.rows };
  }

  async scanCis({ cis, source_type, source_id, product_id, warehouse_id, product_group } = {}, ctx) {
    this._scope(ctx);
    const { profileId, organizationId } = ctx;
    const code = normalizeCis(cis);
    if (!code) throw httpError('Отсканируйте код маркировки');

    let gis = null;
    try {
      const checked = await chestnyZnakService.checkCises([code], ctx);
      gis = (checked.items || [])[0] || null;
    } catch (err) {
      gis = { ok: false, error_message: err.message, cis: code };
    }

    const gtin = gis?.gtin || extractGtinFromCis(code);
    const pg = String(product_group || gis?.product_group || '').trim() || null;
    const ownerInn = gis?.owner_inn ? String(gis.owner_inn).replace(/\D/g, '').slice(0, 12) : null;
    const gisStatus = gis?.status || null;
    const status = gis && gis.ok === false ? 'error' : 'scanned';
    const errorMessage = gis && gis.ok === false ? (gis.error_message || 'Код не принят ГИС МТ') : null;

    const row = await query(
      `INSERT INTO chestny_znak_cis (
         profile_id, organization_id, cis, gtin, product_id, product_group, warehouse_id,
         status, gis_status, owner_inn, source_type, source_id, error_message, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
       ON CONFLICT (profile_id, organization_id, cis)
       DO UPDATE SET
         gtin = COALESCE(EXCLUDED.gtin, chestny_znak_cis.gtin),
         product_id = COALESCE(EXCLUDED.product_id, chestny_znak_cis.product_id),
         product_group = COALESCE(EXCLUDED.product_group, chestny_znak_cis.product_group),
         warehouse_id = COALESCE(EXCLUDED.warehouse_id, chestny_znak_cis.warehouse_id),
         gis_status = EXCLUDED.gis_status,
         owner_inn = COALESCE(EXCLUDED.owner_inn, chestny_znak_cis.owner_inn),
         source_type = COALESCE(EXCLUDED.source_type, chestny_znak_cis.source_type),
         source_id = COALESCE(EXCLUDED.source_id, chestny_znak_cis.source_id),
         error_message = EXCLUDED.error_message,
         status = CASE
           WHEN chestny_znak_cis.status IN ('withdrawn', 'transferred') THEN chestny_znak_cis.status
           WHEN EXCLUDED.status = 'error' THEN 'error'
           ELSE chestny_znak_cis.status
         END,
         updated_at = NOW()
       RETURNING *`,
      [
        profileId,
        organizationId,
        code,
        gtin,
        product_id || null,
        pg,
        warehouse_id || null,
        status,
        gisStatus,
        ownerInn,
        source_type || null,
        source_id != null && source_id !== '' ? Number(source_id) : null,
        errorMessage,
      ]
    );
    return { item: row.rows[0], gis };
  }

  async listDocuments({ kind, status, limit = 100 } = {}, ctx) {
    this._scope(ctx);
    const { profileId, organizationId } = ctx;
    const params = [profileId, organizationId];
    const where = ['profile_id = $1', 'organization_id = $2'];
    if (kind) {
      params.push(String(kind));
      where.push(`doc_kind = $${params.length}`);
    }
    if (status) {
      params.push(String(status));
      where.push(`status = $${params.length}`);
    }
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 300));
    const docs = await query(
      `SELECT * FROM chestny_znak_documents
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC
       LIMIT $${params.length}`,
      params
    );
    const ids = docs.rows.map((d) => d.id);
    let links = [];
    if (ids.length) {
      const lr = await query(
        `SELECT d.document_id, c.cis, c.status, c.gtin, c.id AS cis_id
         FROM chestny_znak_document_cises d
         JOIN chestny_znak_cis c ON c.id = d.cis_id
         WHERE d.document_id = ANY($1::bigint[])`,
        [ids]
      );
      links = lr.rows;
    }
    const byDoc = new Map();
    for (const row of links) {
      if (!byDoc.has(row.document_id)) byDoc.set(row.document_id, []);
      byDoc.get(row.document_id).push(row);
    }
    return {
      items: docs.rows.map((d) => ({ ...d, cises: byDoc.get(d.id) || [] })),
    };
  }

  async createDocument({ kind, cis_ids, cises, product_group, source_type, source_id } = {}, ctx) {
    this._scope(ctx);
    const op = operationById(kind);
    if (!op) throw httpError('Неизвестная схема документа');
    const cfg = await this._assertOperationEnabled(kind, ctx);
    const { profileId, organizationId } = ctx;

    let ids = Array.isArray(cis_ids) ? cis_ids.map(Number).filter(Boolean) : [];
    if (!ids.length && cises) {
      const list = splitCisList(cises);
      if (!list.length) throw httpError('Добавьте коды маркировки');
      const found = await query(
        `SELECT id FROM chestny_znak_cis
         WHERE profile_id = $1 AND organization_id = $2 AND cis = ANY($3::text[])`,
        [profileId, organizationId, list]
      );
      ids = found.rows.map((r) => Number(r.id));
      if (ids.length !== list.length) {
        throw httpError('Сначала отсканируйте все КИ в реестр этой организации');
      }
    }
    if (!ids.length) throw httpError('Документ без кодов маркировки');

    const cisRows = await query(
      `SELECT * FROM chestny_znak_cis
       WHERE profile_id = $1 AND organization_id = $2 AND id = ANY($3::bigint[])`,
      [profileId, organizationId, ids]
    );
    if (cisRows.rows.length !== ids.length) {
      throw httpError('Часть кодов не принадлежит этой организации');
    }

    const pg = String(product_group || cisRows.rows[0]?.product_group || cfg.product_groups?.[0] || '').trim();
    if (!pg) throw httpError('Укажите товарную группу документа');

    const inn = String(cfg.inn || '').replace(/\D/g, '').slice(0, 12);
    const date = todayIsoDate();
    const payload = op.gis_type === 'LK_RECEIPT'
      ? buildLkReceiptPayload({
        inn,
        action: op.gis_action,
        actionDate: date,
        documentNumber: `${kind}-${Date.now()}`,
        documentDate: date,
        products: cisRows.rows.map((r) => r.cis),
      })
      : {
        inn,
        doc_kind: kind,
        gis_type: op.gis_type,
        products: cisRows.rows.map((r) => ({ cis: r.cis, gtin: r.gtin })),
        note: op.channel === 'edo'
          ? 'Список КИ для УПД. Подпишите УПД в ЭДО, затем отметьте документ выполненным.'
          : null,
      };

    const initialStatus = op.channel === 'edo' ? 'edo_pending' : 'ready';
    const ins = await query(
      `INSERT INTO chestny_znak_documents (
         profile_id, organization_id, doc_kind, gis_type, gis_action, status, channel,
         product_group, inn, source_type, source_id, payload, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, NOW())
       RETURNING *`,
      [
        profileId,
        organizationId,
        kind,
        op.gis_type,
        op.gis_action,
        initialStatus,
        op.channel,
        pg,
        inn || null,
        source_type || null,
        source_id != null && source_id !== '' ? Number(source_id) : null,
        JSON.stringify(payload),
      ]
    );
    const doc = ins.rows[0];
    await query(
      `INSERT INTO chestny_znak_document_cises (document_id, cis_id)
       SELECT $1, x FROM unnest($2::bigint[]) AS x
       ON CONFLICT DO NOTHING`,
      [doc.id, ids]
    );
    const nextStatus = nextCisStatus(kind, initialStatus);
    if (nextStatus) {
      await query(
        `UPDATE chestny_znak_cis
         SET status = $3, last_document_id = $4, dest_type = $5, dest_id = $4, updated_at = NOW()
         WHERE id = ANY($1::bigint[]) AND profile_id = $2`,
        [ids, profileId, nextStatus, doc.id, kind]
      );
    }
    logger.info('[ChestnyZnak] document created', { organizationId, kind, id: doc.id, codes: ids.length });
    return this.getDocument(doc.id, ctx);
  }

  async getDocument(id, ctx) {
    this._scope(ctx);
    const { profileId, organizationId } = ctx;
    const r = await query(
      `SELECT * FROM chestny_znak_documents
       WHERE id = $1 AND profile_id = $2 AND organization_id = $3`,
      [id, profileId, organizationId]
    );
    if (!r.rows[0]) throw httpError('Документ не найден', 404);
    const links = await query(
      `SELECT c.* FROM chestny_znak_document_cises d
       JOIN chestny_znak_cis c ON c.id = d.cis_id
       WHERE d.document_id = $1`,
      [id]
    );
    return { ...r.rows[0], cises: links.rows };
  }

  async signingPayload(id, ctx) {
    const doc = await this.getDocument(id, ctx);
    if (doc.channel !== 'true_api') {
      throw httpError('Этот документ проводится через ЭДО, подпись True API не нужна');
    }
    const raw = typeof doc.payload === 'string' ? doc.payload : JSON.stringify(doc.payload || {});
    return {
      id: doc.id,
      gis_type: doc.gis_type,
      product_group: doc.product_group,
      json: typeof doc.payload === 'object' ? doc.payload : JSON.parse(raw),
      to_sign: raw,
    };
  }

  async markEdoDone(id, ctx) {
    const doc = await this.getDocument(id, ctx);
    if (doc.channel !== 'edo') throw httpError('Это не документ ЭДО');
    await query(
      `UPDATE chestny_znak_documents
       SET status = 'edo_done', sent_at = NOW(), updated_at = NOW(), error_message = NULL
       WHERE id = $1`,
      [id]
    );
    const next = nextCisStatus(doc.doc_kind, 'edo_done');
    if (next) {
      await query(
        `UPDATE chestny_znak_cis SET status = $2, updated_at = NOW()
         WHERE last_document_id = $1`,
        [id, next]
      );
    }
    return this.getDocument(id, ctx);
  }

  async submitDocument(id, { signature } = {}, ctx) {
    const doc = await this.getDocument(id, ctx);
    if (doc.channel !== 'true_api') {
      throw httpError('Документ ЭДО отправляется оператору ЭДО, не в True API');
    }
    const sig = String(signature || '').replace(/\s+/g, '');
    if (!sig) throw httpError('Нужна откреплённая подпись УКЭП тела документа');
    const cfg = await chestnyZnakService._requireLiveToken(ctx);
    const payloadObj = doc.payload && typeof doc.payload === 'object'
      ? doc.payload
      : JSON.parse(String(doc.payload || '{}'));
    const body = {
      document_format: 'MANUAL',
      type: doc.gis_type,
      product_document: encodeProductDocument(payloadObj),
      signature: sig,
    };
    const pg = String(doc.product_group || '').trim();
    const path = pg ? `/lk/documents/create?pg=${encodeURIComponent(pg)}` : '/lk/documents/create';
    const { res, json, text } = await chestnyZnakService._trueApiFetch(cfg, 'POST', path, { body });
    if (!res.ok) {
      const msg = chestnyZnakService._gisMessage(json, `ГИС МТ отклонила документ (HTTP ${res.status})`);
      await query(
        `UPDATE chestny_znak_documents
         SET status = 'rejected', error_message = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, msg]
      );
      throw httpError(msg, res.status >= 500 ? 502 : 400, json || text);
    }
    const gisId = String(json?.value || json?.documentId || json?.id || json || '').slice(0, 80);
    await query(
      `UPDATE chestny_znak_documents
       SET status = 'sent', gis_doc_id = $2, sent_at = NOW(), error_message = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id, gisId || null]
    );
    const next = nextCisStatus(doc.doc_kind, 'sent');
    if (next) {
      await query(
        `UPDATE chestny_znak_cis SET status = $2, updated_at = NOW()
         WHERE last_document_id = $1`,
        [id, next]
      );
    }
    logger.info('[ChestnyZnak] document sent', { id, gisId, kind: doc.doc_kind });
    return this.getDocument(id, ctx);
  }
}

export default new ChestnyZnakDocsService();
