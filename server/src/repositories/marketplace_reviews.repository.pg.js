/**
 * Отзывы с маркетплейсов (PostgreSQL)
 */

import { query } from '../config/database.js';

function rowToApi(row) {
  if (!row) return row;
  return {
    id: row.id != null ? String(row.id) : null,
    profileId: row.profile_id != null ? Number(row.profile_id) : null,
    marketplace: row.marketplace,
    externalId: row.external_id,
    rating: row.rating != null ? Number(row.rating) : null,
    body: row.body,
    hasText: !!row.has_text,
    answerText: row.answer_text,
    status: row.status,
    skuOrOffer: row.sku_or_offer,
    sourceCreatedAt: row.source_created_at,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class MarketplaceReviewsRepositoryPG {
  async findRowByIdAndProfile(id, profileId) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid < 1) return null;
    const result = await query('SELECT * FROM marketplace_reviews WHERE id = $1 AND profile_id = $2', [
      nid,
      profileId,
    ]);
    return result.rows[0] || null;
  }

  async updateAnswerFields(id, profileId, answerText, rawPayload = undefined) {
    const nid = Number(id);
    if (!Number.isFinite(nid) || nid < 1) return null;
    if (rawPayload !== undefined) {
      const result = await query(
        `UPDATE marketplace_reviews
         SET answer_text = $3, raw_payload = $4::jsonb, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND profile_id = $2
         RETURNING *`,
        [nid, profileId, answerText, JSON.stringify(rawPayload)]
      );
      return rowToApi(result.rows[0]);
    }
    const result = await query(
      `UPDATE marketplace_reviews
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
      rating,
      body,
      has_text,
      answer_text,
      status,
      sku_or_offer,
      source_created_at,
      raw_payload,
    } = row;
    const result = await query(
      `INSERT INTO marketplace_reviews (
        profile_id, marketplace, external_id, rating, body, has_text, answer_text, status,
        sku_or_offer, source_created_at, raw_payload, synced_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (profile_id, marketplace, external_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        body = EXCLUDED.body,
        has_text = EXCLUDED.has_text,
        -- не затираем локально сохранённый ответ пустым значением от маркетплейса
        answer_text = CASE
          WHEN EXCLUDED.answer_text IS NULL OR TRIM(COALESCE(EXCLUDED.answer_text, '')) = ''
            THEN marketplace_reviews.answer_text
          ELSE EXCLUDED.answer_text
        END,
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
        rating != null ? Number(rating) : null,
        body ?? '',
        !!has_text,
        answer_text ?? null,
        status ?? null,
        sku_or_offer ?? null,
        source_created_at ?? null,
        raw_payload != null ? JSON.stringify(raw_payload) : null,
      ]
    );
    return rowToApi(result.rows[0]);
  }

  async list(profileId, queryParams = {}) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return [];

    const marketplaceRaw = queryParams.marketplace ?? null;
    const marketplace =
      marketplaceRaw != null && String(marketplaceRaw).trim() !== '' && String(marketplaceRaw).trim() !== 'all'
        ? String(marketplaceRaw).trim().toLowerCase()
        : null;
    const answeredRaw = queryParams.answered ?? null;
    const answered =
      answeredRaw != null && String(answeredRaw).trim() !== '' && String(answeredRaw).trim() !== 'all'
        ? String(answeredRaw).trim().toLowerCase()
        : null; // 'new' | 'answered'
    const hasTextRaw = queryParams.hasText ?? queryParams.has_text ?? null;
    const hasText =
      hasTextRaw === true ||
      hasTextRaw === 'true' ||
      hasTextRaw === '1' ||
      hasTextRaw === 1 ||
      hasTextRaw === 'yes';
    const starsRaw = queryParams.stars ?? queryParams.rating ?? null;
    const starsNum = starsRaw != null && String(starsRaw).trim() !== '' ? Number(starsRaw) : null;
    const stars = Number.isFinite(starsNum) && starsNum >= 1 && starsNum <= 5 ? Math.round(starsNum) : null;

    const sortRaw = queryParams.sort ?? null;
    const sort = sortRaw ? String(sortRaw).trim().toLowerCase() : 'date_desc';

    const where = ['profile_id = $1'];
    const params = [pid];
    let i = 2;
    if (marketplace) {
      where.push(`marketplace = $${i++}`);
      params.push(marketplace);
    }
    if (stars != null) {
      where.push(`rating = $${i++}`);
      params.push(stars);
    }
    if (hasTextRaw != null && String(hasTextRaw).trim() !== '' && String(hasTextRaw).trim() !== 'all') {
      where.push(`has_text = $${i++}`);
      params.push(!!hasText);
    }
    if (answered === 'new') {
      where.push(`(answer_text IS NULL OR TRIM(COALESCE(answer_text, '')) = '')`);
    } else if (answered === 'answered') {
      where.push(`(answer_text IS NOT NULL AND TRIM(COALESCE(answer_text, '')) <> '')`);
    }

    const orderBy = (() => {
      if (sort === 'rating_asc') return 'rating ASC NULLS LAST, source_created_at DESC NULLS LAST, id DESC';
      if (sort === 'rating_desc') return 'rating DESC NULLS LAST, source_created_at DESC NULLS LAST, id DESC';
      if (sort === 'date_asc') return 'source_created_at ASC NULLS LAST, id ASC';
      return 'source_created_at DESC NULLS LAST, id DESC';
    })();

    const limitRaw = queryParams.limit != null ? Number(queryParams.limit) : 200;
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.round(limitRaw))) : 200;
    const offsetRaw = queryParams.offset != null ? Number(queryParams.offset) : 0;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.round(offsetRaw)) : 0;

    const sql = `
      SELECT * FROM marketplace_reviews
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${i++} OFFSET $${i++}
    `;
    params.push(limit, offset);
    const result = await query(sql, params);
    return (result.rows || []).map(rowToApi);
  }

  async getStats(profileId, queryParams = {}) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) {
      return { newCount: 0, counts: { all: 0, new: 0, answered: 0 }, countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 } };
    }
    const marketplaceRaw = queryParams.marketplace ?? null;
    const marketplace =
      marketplaceRaw != null && String(marketplaceRaw).trim() !== '' && String(marketplaceRaw).trim() !== 'all'
        ? String(marketplaceRaw).trim().toLowerCase()
        : null;

    const where = ['profile_id = $1'];
    const params = [pid];
    let i = 2;
    if (marketplace) {
      where.push(`marketplace = $${i++}`);
      params.push(marketplace);
    }
    const baseWhere = where.join(' AND ');

    const totalRes = await query(`SELECT COUNT(*)::bigint AS c FROM marketplace_reviews WHERE ${baseWhere}`, params);
    const newRes = await query(
      `SELECT COUNT(*)::bigint AS c FROM marketplace_reviews WHERE ${baseWhere} AND (answer_text IS NULL OR TRIM(COALESCE(answer_text, '')) = '')`,
      params
    );
    const answeredRes = await query(
      `SELECT COUNT(*)::bigint AS c FROM marketplace_reviews WHERE ${baseWhere} AND (answer_text IS NOT NULL AND TRIM(COALESCE(answer_text, '')) <> '')`,
      params
    );

    const byMpRes = await query(
      `SELECT marketplace, COUNT(*)::bigint AS c
       FROM marketplace_reviews
       WHERE profile_id = $1
       GROUP BY marketplace`,
      [pid]
    );
    const by = { ozon: 0, wildberries: 0, yandex: 0 };
    for (const r of byMpRes.rows || []) {
      const mp = String(r.marketplace || '').trim().toLowerCase();
      const n = Number(r.c);
      if (mp && Number.isFinite(n) && Object.prototype.hasOwnProperty.call(by, mp)) by[mp] = n;
    }

    const all = Number(totalRes.rows?.[0]?.c) || 0;
    const nw = Number(newRes.rows?.[0]?.c) || 0;
    const ans = Number(answeredRes.rows?.[0]?.c) || 0;

    return {
      newCount: nw,
      counts: { all, new: nw, answered: ans },
      countsByMarketplace: by,
    };
  }
}

export default new MarketplaceReviewsRepositoryPG();

