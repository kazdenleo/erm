/**
 * Вопросы с маркетплейсов (PostgreSQL)
 */

import { query } from '../config/database.js';
import { extractYandexGoodsQuestionOfferId } from '../utils/yandex-goods-question-offer.js';
import { buildThreadMessagesFromRow } from '../utils/marketplaceQuestionThread.js';
import { sanitizeMarketplaceBuyerName } from '../utils/marketplaceBuyerName.js';

/** «Новый» = ждёт ответа продавца: последнее в thread_messages — buyer или ветка ещё не собрана и нет answer_text */
const SQL_NEEDS_REPLY = `(
  (jsonb_array_length(COALESCE(thread_messages, '[]'::jsonb)) > 0 AND (thread_messages->-1->>'role') = 'buyer')
  OR (
    jsonb_array_length(COALESCE(thread_messages, '[]'::jsonb)) = 0
    AND (answer_text IS NULL OR TRIM(COALESCE(answer_text, '')) = '')
  )
)`;

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

function pendingAnswerTextFromRawPayload(raw) {
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
  const t = o.pendingAnswerText ?? o.pending_answer_text ?? null;
  const s = t != null ? String(t).trim() : '';
  return s ? s : null;
}

function parseRawPayloadObject(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' ? raw : null;
}

function isSellerAuthorType(type) {
  const t = String(type ?? '').toUpperCase();
  if (!t) return false;
  return (
    t.includes('SELLER') ||
    t.includes('SHOP') ||
    t.includes('PARTNER') ||
    t.includes('BUSINESS') ||
    t.includes('MERCHANT')
  );
}

function buyerNameFromRawPayload(marketplace, raw) {
  const o = parseRawPayloadObject(raw);
  if (!o || typeof o !== 'object') return null;

  const mp = String(marketplace || '').toLowerCase();

  const candidates = [];

  const pushAuthorName = (author) => {
    if (!author || typeof author !== 'object') return;
    if (isSellerAuthorType(author.type ?? author.author_type)) return;
    candidates.push(
      author.name,
      author.fullName,
      author.full_name,
      author.nickname,
      author.displayName,
      author.display_name
    );
  };

  pushAuthorName(o.author);
  pushAuthorName(o.questionAuthor);
  pushAuthorName(o.question_author);
  pushAuthorName(o.customer);
  pushAuthorName(o.buyer);
  pushAuthorName(o.client);
  pushAuthorName(o.user);

  candidates.push(
    o.userName,
    o.user_name,
    o.customerName,
    o.customer_name,
    o.buyerName,
    o.buyer_name,
    o.nickname,
    o.displayName,
    o.display_name
  );

  // Яндекс.Маркет: имя покупателя часто только в author.name на корне вопроса.
  if (mp === 'yandex' || mp === 'ym') {
    candidates.unshift(o.author?.name, o.author?.nickname);
  }
  if (mp === 'ozon') {
    candidates.unshift(o.author_name, o.authorName, o.author?.name);
  }
  if (mp === 'wildberries' || mp === 'wb') {
    candidates.unshift(o.userName, o.user_name, o.clientName, o.client_name);
  }

  for (const v of candidates) {
    const s = sanitizeMarketplaceBuyerName(v, mp);
    if (s) return s;
  }
  return null;
}

function ozonArticleFromRawPayload(raw) {
  const o = parseRawPayloadObject(raw);
  if (!o) return null;
  const offer = o.offer_id ?? o.offerId;
  if (offer != null && String(offer).trim() !== '') {
    const s = String(offer).trim();
    if (!/^\d{6,}$/.test(s)) return s;
  }
  return null;
}

function resolveDisplayCreatedAt(row) {
  if (row.source_created_at != null) {
    const d = new Date(row.source_created_at);
    if (!Number.isNaN(d.getTime())) return row.source_created_at;
  }
  const raw = parseRawPayloadObject(row.raw_payload);
  if (raw && typeof raw === 'object') {
    const mp = String(row.marketplace || '').toLowerCase();
    const cand =
      mp === 'ozon'
        ? [raw.published_at, raw.publishedAt, raw.created_at, raw.createdAt]
        : mp === 'wildberries' || mp === 'wb'
          ? [raw.createdDate, raw.created_at]
          : [raw.createdAt, raw.created_at];
    for (const v of cand) {
      if (v == null || v === '') continue;
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return row.synced_at ?? row.created_at ?? null;
}

function rowToApi(row, opts = {}) {
  if (!row) return row;
  let subject = row.subject;
  let skuOrOffer = row.sku_or_offer;
  if (row.marketplace === 'wildberries') {
    const fromRaw = wbSupplierArticleFromRawPayload(row.raw_payload);
    if (fromRaw) {
      skuOrOffer = fromRaw;
    }
  }
  if (row.marketplace === 'ozon') {
    const colSku =
      skuOrOffer != null && String(skuOrOffer).trim() !== '' && !/^\d{6,}$/.test(String(skuOrOffer).trim())
        ? String(skuOrOffer).trim()
        : null;
    const fromRaw = ozonArticleFromRawPayload(row.raw_payload);
    skuOrOffer = colSku || fromRaw || null;
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
    buyerName: buyerNameFromRawPayload(row.marketplace, row.raw_payload),
    pendingAnswerText: pendingAnswerTextFromRawPayload(row.raw_payload),
    body: row.body,
    answerText: row.answer_text,
    status: row.status,
    skuOrOffer,
    sourceCreatedAt: resolveDisplayCreatedAt(row),
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (
    row.raw_payload != null &&
    (out.skuOrOffer == null ||
      String(out.skuOrOffer).trim() === '' ||
      out.buyerName == null ||
      out.sourceCreatedAt == null)
  ) {
    out.rawPayload = parseRawPayloadObject(row.raw_payload);
  }
  if (opts.includeRaw && row.raw_payload != null) {
    out.rawPayload = parseRawPayloadObject(row.raw_payload);
  }
  let threadMessages = [];
  if (Array.isArray(row.thread_messages) && row.thread_messages.length > 0) {
    threadMessages = row.thread_messages;
  } else {
    try {
      threadMessages = buildThreadMessagesFromRow({
        marketplace: row.marketplace,
        rawPayload: row.raw_payload,
        body: row.body,
        answerText: row.answer_text,
        sourceCreatedAt: row.source_created_at,
      });
    } catch {
      threadMessages = [];
    }
  }
  out.threadMessages = threadMessages;
  out.needsReply = computeNeedsReply(row, threadMessages);
  return out;
}

function computeNeedsReply(row, threadMessages) {
  const tm = Array.isArray(threadMessages) ? threadMessages : [];
  if (tm.length > 0) {
    return String(tm[tm.length - 1]?.role || '').toLowerCase() === 'buyer';
  }
  const t = row.answer_text;
  return t == null || String(t).trim() === '';
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

  /** Одна строка в формате API (с threadMessages). */
  async findOneApiByIdAndProfile(id, profileId) {
    const row = await this.findRowByIdAndProfile(id, profileId);
    return row ? rowToApi(row, { includeRaw: true }) : null;
  }

  async deleteByIdAndProfile(id, profileId) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid < 1) return false;
    const result = await query(
      'DELETE FROM marketplace_questions WHERE id = $1 AND profile_id = $2',
      [nid, profileId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Вопросы «ждут ответа» в БД, но уже нет в списке неотвеченных на МП — для архивации.
   * @returns {Promise<object[]>}
   */
  async findNeedingReplyMissingFromMarketplace(profileId, marketplace, externalIds, { allIfEmpty = false } = {}) {
    const mp = String(marketplace || '').trim();
    if (!['ozon', 'wildberries', 'yandex'].includes(mp)) return [];
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return [];

    const ids = Array.isArray(externalIds)
      ? externalIds.map((x) => String(x).trim()).filter(Boolean)
      : [];

    if (ids.length === 0) {
      if (!allIfEmpty) return [];
      const result = await query(
        `SELECT * FROM marketplace_questions
         WHERE profile_id = $1 AND marketplace = $2 AND ${SQL_NEEDS_REPLY}`,
        [pid, mp]
      );
      return result.rows || [];
    }

    const result = await query(
      `SELECT * FROM marketplace_questions
       WHERE profile_id = $1 AND marketplace = $2 AND ${SQL_NEEDS_REPLY}
         AND NOT (external_id = ANY($3::text[]))`,
      [pid, mp, ids]
    );
    return result.rows || [];
  }

  /**
   * Убираем из БД вопросы, которые больше не в списке «без ответа» на МП
   * (ответили на маркетплейсе или ветка закрыта с нашей стороны).
   * @deprecated Используйте findNeedingReplyMissingFromMarketplace + upsert для архива.
   */
  async deleteUnansweredMissingFromMarketplace(profileId, marketplace, externalIds, { purgeAllIfEmpty = false } = {}) {
    const mp = String(marketplace || '').trim();
    if (!['ozon', 'wildberries', 'yandex'].includes(mp)) return { deleted: 0 };
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return { deleted: 0 };

    const ids = Array.isArray(externalIds)
      ? externalIds.map((x) => String(x).trim()).filter(Boolean)
      : [];

    if (ids.length === 0) {
      if (!purgeAllIfEmpty) return { deleted: 0 };
      const result = await query(
        `DELETE FROM marketplace_questions
         WHERE profile_id = $1 AND marketplace = $2 AND ${SQL_NEEDS_REPLY}`,
        [pid, mp]
      );
      return { deleted: result.rowCount != null ? Number(result.rowCount) : 0 };
    }

    const result = await query(
      `DELETE FROM marketplace_questions
       WHERE profile_id = $1 AND marketplace = $2 AND ${SQL_NEEDS_REPLY}
         AND NOT (external_id = ANY($3::text[]))`,
      [pid, mp, ids]
    );
    return { deleted: result.rowCount != null ? Number(result.rowCount) : 0 };
  }

  /** После upsert: удалить строки, у которых по данным ветки ответ уже не требуется. */
  async deleteNotNeedingReplyByProfile(profileId) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return { deleted: 0 };
    const result = await query(
      `DELETE FROM marketplace_questions
       WHERE profile_id = $1 AND NOT (${SQL_NEEDS_REPLY})`,
      [pid]
    );
    return { deleted: result.rowCount != null ? Number(result.rowCount) : 0 };
  }

  /**
   * @param {string|number} id
   * @param {number} profileId
   * @param {string} answerText
   * @param {object|null} [rawPayload]
   */
  async updateAnswerFields(id, profileId, answerText, rawPayload = undefined, threadMessages = undefined) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid < 1) return null;
    const sets = ['answer_text = $3', 'synced_at = CURRENT_TIMESTAMP', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [nid, profileId, answerText];
    let p = 4;
    if (rawPayload !== undefined) {
      sets.push(`raw_payload = $${p}::jsonb`);
      params.push(JSON.stringify(rawPayload));
      p += 1;
    }
    if (threadMessages !== undefined) {
      sets.push(`thread_messages = $${p}::jsonb`);
      params.push(JSON.stringify(threadMessages));
      p += 1;
    }
    const result = await query(
      `UPDATE marketplace_questions SET ${sets.join(', ')} WHERE id = $1 AND profile_id = $2 RETURNING *`,
      params
    );
    return rowToApi(result.rows[0]);
  }

  /**
   * Для WB: ответ может появляться в API с задержкой или не подтверждаться.
   * Сохраняем текст как pending в raw_payload и ставим status=pending_wb_confirm, не заполняя answer_text.
   */
  async setPendingAnswer(id, profileId, pendingText) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid < 1) return null;
    const txt = pendingText != null ? String(pendingText).trim() : '';
    if (!txt) return null;
    const patch = {
      pendingAnswerText: txt,
      pendingAnswerAt: new Date().toISOString(),
    };
    const result = await query(
      `UPDATE marketplace_questions
       SET status = 'pending_wb_confirm',
           raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $3::jsonb,
           synced_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND profile_id = $2
       RETURNING *`,
      [nid, profileId, JSON.stringify(patch)]
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
      thread_messages,
    } = row;
    const threadJson =
      thread_messages != null ? JSON.stringify(thread_messages) : JSON.stringify([]);
    const result = await query(
      `INSERT INTO marketplace_questions (
        profile_id, marketplace, external_id, subject, body, answer_text, status,
        sku_or_offer, source_created_at, raw_payload, thread_messages, synced_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (profile_id, marketplace, external_id) DO UPDATE SET
        subject = EXCLUDED.subject,
        body = EXCLUDED.body,
        -- не затираем локально сохранённый ответ пустым значением от маркетплейса (у WB ответ может появляться с задержкой)
        answer_text = CASE
          WHEN EXCLUDED.answer_text IS NULL OR TRIM(COALESCE(EXCLUDED.answer_text, '')) = ''
            THEN marketplace_questions.answer_text
          ELSE EXCLUDED.answer_text
        END,
        -- если answer_text пустой, не сбрасываем локальный статус (например pending_wb_confirm)
        status = CASE
          WHEN EXCLUDED.answer_text IS NOT NULL AND TRIM(COALESCE(EXCLUDED.answer_text, '')) <> '' THEN EXCLUDED.status
          ELSE marketplace_questions.status
        END,
        sku_or_offer = EXCLUDED.sku_or_offer,
        source_created_at = EXCLUDED.source_created_at,
        -- при pending_wb_confirm не теряем pendingAnswerText/At при синхронизации
        raw_payload = CASE
          WHEN marketplace_questions.status = 'pending_wb_confirm'
            THEN COALESCE(EXCLUDED.raw_payload, '{}'::jsonb) || COALESCE(marketplace_questions.raw_payload, '{}'::jsonb)
          ELSE EXCLUDED.raw_payload
        END,
        thread_messages = EXCLUDED.thread_messages,
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
        threadJson,
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
    const answered =
      opts.answered === 'answered' ? 'answered' : opts.answered === 'all' ? 'all' : 'new';
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
      sql += ` AND ${SQL_NEEDS_REPLY}`;
    } else if (answered === 'answered') {
      sql += ` AND NOT (${SQL_NEEDS_REPLY})`;
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
    let sql = `SELECT COUNT(*)::int AS c FROM marketplace_questions WHERE profile_id = $1 AND ${SQL_NEEDS_REPLY}`;
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
      COUNT(*) FILTER (WHERE ${SQL_NEEDS_REPLY})::int AS new_count,
      COUNT(*) FILTER (WHERE NOT (${SQL_NEEDS_REPLY}))::int AS answered_count
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
       FROM marketplace_questions WHERE profile_id = $1 AND ${SQL_NEEDS_REPLY}
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
