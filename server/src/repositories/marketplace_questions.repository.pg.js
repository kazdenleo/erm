/**
 * Вопросы с маркетплейсов (PostgreSQL)
 */

import { query } from '../config/database.js';
import { extractYandexGoodsQuestionOfferId } from '../utils/yandex-goods-question-offer.js';

function wbSupplierArticleFromRawPayload(raw) {
  if (raw == null) return null;
  const o =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : raw;
  if (!o || typeof o !== 'object') return null;
  const pd = o.productDetails ?? o.product_details ?? {};
  const candidates = [
    pd.supplierArticle,
    pd.supplier_article,
    pd.vendorCode,
    pd.vendor_code,
    pd.article,
  ];
  for (const v of candidates) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

function rowToApi(row) {
  if (!row) return row;
  let subject = row.subject;
  let skuOrOffer = row.sku_or_offer;
  if (row.marketplace === 'wildberries') {
    const fromRaw = wbSupplierArticleFromRawPayload(row.raw_payload);
    if (fromRaw) {
      skuOrOffer = fromRaw;
    }
  }
  if (row.marketplace === 'yandex') {
    const colSku =
      skuOrOffer != null && String(skuOrOffer).trim() !== '' ? String(skuOrOffer).trim() : null;
    const fromRaw = extractYandexGoodsQuestionOfferId(row.raw_payload);
    skuOrOffer = colSku || fromRaw || null;
    if (skuOrOffer && (subject == null || String(subject).trim() === '')) {
      subject = String(skuOrOffer);
    }
  }
  const out = {
    id: row.id != null ? String(row.id) : null,
    profileId: row.profile_id != null ? Number(row.profile_id) : null,
    marketplace: row.marketplace,
    externalId: row.external_id,
    subject,
    body: row.body,
    answerText: row.answer_text,
    status: row.status,
    skuOrOffer,
    sourceCreatedAt: row.source_created_at,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (
    row.marketplace === 'yandex' &&
    row.raw_payload != null &&
    (out.skuOrOffer == null || String(out.skuOrOffer).trim() === '')
  ) {
    out.rawPayload = row.raw_payload;
  }
  return out;
}

class MarketplaceQuestionsRepositoryPG {
  /**
   * Полная строка БД (для отправки ответа на МП).
   * @param {string|number} id
   * @param {number} profileId
   */
  async findRowByIdAndProfile(id, profileId) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid < 1) return null;
    const result = await query(
      'SELECT * FROM marketplace_questions WHERE id = $1 AND profile_id = $2',
      [nid, profileId]
    );
    return result.rows[0] || null;
  }

  /**
   * @param {string|number} id
   * @param {number} profileId
   * @param {string} answerText
   * @param {object|null} [rawPayload]
   */
  async updateAnswerFields(id, profileId, answerText, rawPayload = undefined) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid < 1) return null;
    if (rawPayload !== undefined) {
      const result = await query(
        `UPDATE marketplace_questions
         SET answer_text = $3, raw_payload = $4::jsonb, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND profile_id = $2
         RETURNING *`,
        [nid, profileId, answerText, JSON.stringify(rawPayload)]
      );
      return rowToApi(result.rows[0]);
    }
    const result = await query(
      `UPDATE marketplace_questions
       SET answer_text = $3, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND profile_id = $2
       RETURNING *`,
      [nid, profileId, answerText]
    );
    return rowToApi(result.rows[0]);
  }

  async upsertRow(row) {
    const {
      profile_id,
      marketplace,
      external_id,
      subject,
      body,
      answer_text,
      status,
      sku_or_offer,
      source_created_at,
      raw_payload,
    } = row;
    const result = await query(
      `INSERT INTO marketplace_questions (
        profile_id, marketplace, external_id, subject, body, answer_text, status,
        sku_or_offer, source_created_at, raw_payload, synced_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (profile_id, marketplace, external_id) DO UPDATE SET
        subject = EXCLUDED.subject,
        body = EXCLUDED.body,
        answer_text = EXCLUDED.answer_text,
        status = EXCLUDED.status,
        sku_or_offer = EXCLUDED.sku_or_offer,
        source_created_at = EXCLUDED.source_created_at,
        raw_payload = EXCLUDED.raw_payload,
        synced_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [
        profile_id,
        marketplace,
        external_id,
        subject ?? null,
        body ?? '',
        answer_text ?? null,
        status ?? null,
        sku_or_offer ?? null,
        source_created_at ?? null,
        raw_payload != null ? JSON.stringify(raw_payload) : null,
      ]
    );
    return rowToApi(result.rows[0]);
  }

  /**
   * @param {number} profileId
   * @param {{ marketplace?: string|null, limit?: number, offset?: number, answered?: 'all'|'new'|'answered' }} [opts]
   */
  async findByProfile(profileId, opts = {}) {
    const marketplace = opts.marketplace != null ? String(opts.marketplace).trim() : null;
    const answered = opts.answered === 'new' || opts.answered === 'answered' ? opts.answered : 'all';
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 500) : 200;
    const offset = Number.isFinite(opts.offset) && opts.offset > 0 ? opts.offset : 0;
    const params = [profileId];
    let sql = 'SELECT * FROM marketplace_questions WHERE profile_id = $1';
    let n = 2;
    if (marketplace && ['ozon', 'wildberries', 'yandex'].includes(marketplace)) {
      sql += ` AND marketplace = $${n}`;
      params.push(marketplace);
      n += 1;
    }
    if (answered === 'new') {
      sql += ` AND (answer_text IS NULL OR TRIM(COALESCE(answer_text, '')) = '')`;
    } else if (answered === 'answered') {
      sql += ` AND answer_text IS NOT NULL AND TRIM(COALESCE(answer_text, '')) <> ''`;
    }
    params.push(limit, offset);
    sql += ` ORDER BY source_created_at DESC NULLS LAST, id DESC LIMIT $${n} OFFSET $${n + 1}`;
    const result = await query(sql, params);
    return (result.rows || []).map(rowToApi);
  }

  /**
   * Число вопросов без ответа продавца (пустой или отсутствующий answer_text).
   * @param {number} profileId
   * @param {{ marketplace?: string|null }} [opts]
   */
  async countUnansweredByProfile(profileId, opts = {}) {
    const marketplace = opts.marketplace != null ? String(opts.marketplace).trim() : null;
    const params = [profileId];
    let sql =
      'SELECT COUNT(*)::int AS c FROM marketplace_questions WHERE profile_id = $1 AND (answer_text IS NULL OR TRIM(COALESCE(answer_text, \'\')) = \'\')';
    let n = 2;
    if (marketplace && ['ozon', 'wildberries', 'yandex'].includes(marketplace)) {
      sql += ` AND marketplace = $${n}`;
      params.push(marketplace);
      n += 1;
    }
    const result = await query(sql, params);
    const row = result.rows[0];
    return row && row.c != null ? Number(row.c) : 0;
  }

  /**
   * Счётчики вопросов: всего / без ответа / с ответом (с опциональным фильтром по МП).
   * @param {number} profileId
   * @param {{ marketplace?: string|null }} [opts]
   * @returns {Promise<{ all: number, new: number, answered: number }>}
   */
  async countBreakdownByProfile(profileId, opts = {}) {
    const marketplace = opts.marketplace != null ? String(opts.marketplace).trim() : null;
    const params = [profileId];
    let sql = `SELECT
      COUNT(*)::int AS all_count,
      COUNT(*) FILTER (WHERE answer_text IS NULL OR TRIM(COALESCE(answer_text, '')) = '')::int AS new_count,
      COUNT(*) FILTER (WHERE answer_text IS NOT NULL AND TRIM(COALESCE(answer_text, '')) <> '')::int AS answered_count
      FROM marketplace_questions WHERE profile_id = $1`;
    let n = 2;
    if (marketplace && ['ozon', 'wildberries', 'yandex'].includes(marketplace)) {
      sql += ` AND marketplace = $${n}`;
      params.push(marketplace);
      n += 1;
    }
    const result = await query(sql, params);
    const row = result.rows[0] || {};
    return {
      all: row.all_count != null ? Number(row.all_count) : 0,
      new: row.new_count != null ? Number(row.new_count) : 0,
      answered: row.answered_count != null ? Number(row.answered_count) : 0,
    };
  }

  /**
   * Количество вопросов по каждому маркетплейсу (для кнопок фильтра).
   * @param {number} profileId
   * @returns {Promise<{ ozon: number, wildberries: number, yandex: number }>}
   */
  async countQuestionsByMarketplace(profileId) {
    const result = await query(
      `SELECT marketplace, COUNT(*)::int AS c
       FROM marketplace_questions WHERE profile_id = $1
       GROUP BY marketplace`,
      [profileId]
    );
    const out = { ozon: 0, wildberries: 0, yandex: 0 };
    for (const row of result.rows || []) {
      const mp = String(row.marketplace || '').trim();
      if (Object.prototype.hasOwnProperty.call(out, mp)) {
        out[mp] = row.c != null ? Number(row.c) : 0;
      }
    }
    return out;
  }

  /**
   * Удаляет дубликаты вопросов Яндекса с одним questionIdentifiers.id
   * (старые строки с «кривым» external_id и новые с числовым id — разные ключи UNIQUE).
   * @param {number} profileId
   * @returns {Promise<{ deleted: number }>}
   */
  async dedupeYandexDuplicateQuestionsByProfile(profileId) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return { deleted: 0 };
    const result = await query(
      `WITH base AS (
         SELECT id,
           profile_id,
           external_id,
           TRIM(BOTH FROM COALESCE(
             NULLIF(TRIM(raw_payload->'questionIdentifiers'->>'id'), ''),
             NULLIF(TRIM(raw_payload->'question_identifiers'->>'id'), ''),
             CASE WHEN external_id ~ '^[0-9]+$' THEN TRIM(external_id) ELSE NULL END
           )) AS canonical
         FROM marketplace_questions
         WHERE marketplace = 'yandex' AND profile_id = $1
       ),
       ranked AS (
         SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY profile_id, canonical
             ORDER BY
               CASE WHEN TRIM(external_id) = canonical THEN 0 ELSE 1 END,
               id ASC
           ) AS rn
         FROM base
         WHERE canonical IS NOT NULL AND canonical <> ''
       )
       DELETE FROM marketplace_questions
       WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`,
      [pid]
    );
    return { deleted: result.rowCount != null ? Number(result.rowCount) : 0 };
  }

  /**
   * Приводит external_id к id вопроса из raw_payload (чтобы следующие upsert не создавали дубликаты).
   * @param {number} profileId
   * @returns {Promise<{ updated: number }>}
   */
  async normalizeYandexExternalIdsForProfile(profileId) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return { updated: 0 };
    const result = await query(
      `UPDATE marketplace_questions mq
       SET external_id = sub.canonical,
           updated_at = CURRENT_TIMESTAMP
       FROM (
         SELECT id,
           TRIM(BOTH FROM COALESCE(
             NULLIF(TRIM(raw_payload->'questionIdentifiers'->>'id'), ''),
             NULLIF(TRIM(raw_payload->'question_identifiers'->>'id'), ''),
             CASE WHEN external_id ~ '^[0-9]+$' THEN TRIM(external_id) ELSE NULL END
           )) AS canonical
         FROM marketplace_questions
         WHERE marketplace = 'yandex' AND profile_id = $1
       ) sub
       WHERE mq.id = sub.id
         AND sub.canonical IS NOT NULL AND sub.canonical <> ''
         AND mq.external_id IS DISTINCT FROM sub.canonical`,
      [pid]
    );
    return { updated: result.rowCount != null ? Number(result.rowCount) : 0 };
  }
}

export default new MarketplaceQuestionsRepositoryPG();
